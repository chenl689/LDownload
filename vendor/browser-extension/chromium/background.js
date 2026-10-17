const api = globalThis.browser ?? globalThis.chrome;
const nativeHostName = 'org.ldownload1.browser';
let autoCaptureEnabled = false;
let diagnosticWrite = Promise.resolve();

const workerTrace = createTrace('service-worker');
workerTrace.log('worker.started', { version: api.runtime.getManifest().version });
api.storage.local.get({ autoCapture: false }).then(value => {
  autoCaptureEnabled = Boolean(value.autoCapture);
  workerTrace.log('setting.auto-capture.loaded', { enabled: autoCaptureEnabled });
}).catch(error => workerTrace.log('setting.auto-capture.load-failed', { error: String(error?.message || error) }));
const captureScriptId = 'ldownload-auto-capture';
const captureOrigins = ['http://*/*', 'https://*/*'];
async function syncAutomaticCapture() {
  const settings = await api.storage.local.get({ autoCapture: false });
  autoCaptureEnabled = Boolean(settings.autoCapture);
  const hasSiteAccess = await api.permissions.contains({ origins: captureOrigins });
  const registered = await api.scripting.getRegisteredContentScripts({ ids: [captureScriptId] });
  if (autoCaptureEnabled && hasSiteAccess && !registered.length) {
    await api.scripting.registerContentScripts([{
      id: captureScriptId,
      matches: captureOrigins,
      js: ['content.js'],
      runAt: 'document_start',
      persistAcrossSessions: true,
    }]);
    const activeTabs = await api.tabs.query({ url: captureOrigins });
    await Promise.all(activeTabs.filter(tab => typeof tab.id === 'number').map(tab =>
      api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
        .catch(error => createTrace('automatic').log('pre-request-interceptor.inject-existing-tab-failed', { tabId: tab.id, error: String(error?.message || error) }))
    ));
    createTrace('automatic').log('pre-request-interceptor.registered', { existingTabCount: activeTabs.length });
  } else if ((!autoCaptureEnabled || !hasSiteAccess) && registered.length) {
    await api.scripting.unregisterContentScripts({ ids: [captureScriptId] });
    createTrace('automatic').log('pre-request-interceptor.unregistered', {});
  }
  if (autoCaptureEnabled && !hasSiteAccess) {
    autoCaptureEnabled = false;
    await api.storage.local.set({ autoCapture: false });
    createTrace('automatic').log('pre-request-interceptor.permission-missing', {});
  }
}
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoCapture) {
    autoCaptureEnabled = Boolean(changes.autoCapture.newValue);
    createTrace('settings').log('setting.auto-capture.changed', { enabled: autoCaptureEnabled });
    void syncAutomaticCapture().catch(error => createTrace('automatic').log('pre-request-interceptor.sync-failed', { error: String(error?.message || error) }));
  }
});
void syncAutomaticCapture().catch(error => workerTrace.log('pre-request-interceptor.start-failed', { error: String(error?.message || error) }));
api.permissions.onRemoved.addListener(permissions => {
  if (permissions.origins?.some(origin => origin === 'http://*/*' || origin === 'https://*/*')) void api.storage.local.set({ autoCapture: false });
});
api.permissions.onAdded.addListener(permissions => {
  if (!permissions.origins?.some(origin => captureOrigins.includes(origin))) return;
  void (async () => {
    const settings = await api.storage.local.get({ autoCaptureEnablePending: false, autoCaptureEnablePendingAt: 0 });
    if (!settings.autoCaptureEnablePending) return;
    if (!Number.isFinite(settings.autoCaptureEnablePendingAt) || Date.now() - settings.autoCaptureEnablePendingAt > 5 * 60 * 1000) {
      await api.storage.local.set({ autoCaptureEnablePending: false, autoCaptureEnablePendingAt: 0 });
      return;
    }
    const hasSiteAccess = await api.permissions.contains({ origins: captureOrigins });
    if (!hasSiteAccess) return;
    // Complete the popup's interrupted save, which is why this runs in the
    // long-lived extension context rather than relying only on popup code.
    await api.storage.local.set({ autoCapture: true, autoCaptureEnablePending: false, autoCaptureEnablePendingAt: 0 });
    createTrace('automatic').log('setting.auto-capture.enabled-after-permission-grant', {});
  })().catch(error => createTrace('automatic').log('setting.auto-capture.permission-save-failed', { error: String(error?.message || error) }));
});

function urlOrigin(value) {
  try { return new URL(value).origin; } catch { return 'invalid-url'; }
}

function createTrace(source) {
  const captureId = crypto.randomUUID();
  const records = [];
  return {
    captureId,
    records,
    log(step, detail = {}) {
      const message = JSON.stringify(detail);
      const record = { timestamp: new Date().toISOString(), captureId, source, step, message };
      records.push({ step, message: JSON.stringify({ source, detail }) });
      console.info('[LDownload capture]', JSON.stringify(record));
      diagnosticWrite = diagnosticWrite.catch(() => {}).then(async () => {
        const stored = await api.storage.local.get({ browserCaptureDiagnostics: [] });
        const previous = Array.isArray(stored.browserCaptureDiagnostics) ? stored.browserCaptureDiagnostics : [];
        await api.storage.local.set({ browserCaptureDiagnostics: [...previous, record].slice(-300) });
      }).catch(error => console.warn('[LDownload capture] Could not persist diagnostics:', error));
    },
  };
}

api.runtime.onInstalled.addListener(details => {
  const trace = createTrace('extension-install');
  trace.log('extension.installed', { reason: details.reason, version: api.runtime.getManifest().version });
  void Promise.resolve(api.contextMenus.removeAll()).then(() => {
    api.contextMenus.create({ id: 'ldownload-link', title: '用 LDownload 下载此链接', contexts: ['link'] });
    api.contextMenus.create({ id: 'ldownload-selection', title: '用 LDownload 下载选中的链接', contexts: ['selection'] });
    trace.log('context-menus.ready', {});
  }).catch(error => {
    trace.log('context-menus.failed', { error: String(error?.message || error) });
    console.error('[LDownload] Context menu setup failed:', error);
  });
});

function isDownloadUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && parsed.host.length > 0
      && !parsed.username
      && !parsed.password;
  } catch { return false; }
}

function normalizeUrls(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .flatMap(value => String(value || '').split(/\r?\n/))
    .map(value => value.trim())
    .filter(value => value.length <= 8192 && isDownloadUrl(value)))].slice(0, 100);
}

function sendNative(urls, trace) {
  return new Promise(resolve => {
    let port;
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* the host may already have exited */ }
      resolve(Boolean(accepted));
    };
    const timer = setTimeout(() => {
      trace.log('native.timeout', { timeoutMs: 30000 });
      finish(false);
    }, 30000);
    trace.log('native.connect.start', { host: nativeHostName });
    try {
      port = api.runtime.connectNative(nativeHostName);
      trace.log('native.connect.opened', { host: nativeHostName });
      port.onMessage.addListener(message => {
        trace.log('native.response', { accepted: Boolean(message?.accepted), error: message?.error || null });
        finish(Boolean(message?.accepted));
      });
      port.onDisconnect.addListener(() => {
        const error = api.runtime.lastError?.message || 'native host disconnected without a response';
        if (!settled) trace.log('native.disconnected', { error });
        finish(false);
      });
      trace.log('native.message.post', { urlCount: urls.length, autoStart: false });
      port.postMessage({
        type: 'download',
        urls,
        autoStart: false,
        captureId: trace.captureId,
        diagnostics: trace.records.slice(-40),
      });
    } catch (error) {
      trace.log('native.connect.failed', { error: String(error?.message || error) });
      finish(false);
    }
  });
}

function uploadFinalDiagnostics(trace) {
  trace.log('diagnostics.upload.start', { stepCount: trace.records.length });
  let port;
  let finished = false;
  const finish = accepted => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { port?.disconnect(); } catch { /* host may already have exited */ }
    if (!accepted) trace.log('diagnostics.upload.not-confirmed', {});
  };
  const timer = setTimeout(() => finish(false), 10000);
  try {
    port = api.runtime.connectNative(nativeHostName);
    port.onMessage.addListener(message => finish(Boolean(message?.accepted)));
    port.onDisconnect.addListener(() => finish(Boolean(api.runtime.lastError == null)));
    port.postMessage({
      type: 'diagnostic',
      captureId: trace.captureId,
      diagnostics: trace.records.slice(-40),
    });
  } catch (error) {
    trace.log('diagnostics.upload.failed', { error: String(error?.message || error) });
    finish(false);
  }
}

async function openProtocolFallback(urls, trace) {
  const batches = [];
  let batch = [];
  for (const url of urls) {
    const candidate = [...batch, url];
    const params = new URLSearchParams();
    candidate.forEach(value => params.append('url', value));
    params.set('captureId', trace.captureId);
    if (params.toString().length > 22000 && batch.length) {
      batches.push(batch);
      batch = [url];
    } else batch = candidate;
  }
  if (batch.length) batches.push(batch);
  for (const values of batches) {
    const params = new URLSearchParams();
    values.forEach(value => params.append('url', value));
    params.set('captureId', trace.captureId);
    trace.log('protocol.fallback.open', { urlCount: values.length, autoStart: false });
    await api.tabs.create({ url: 'ldownload://add?' + params.toString(), active: false });
  }
  return true;
}

async function handoff(values, allowProtocolFallback, trace) {
  const urls = normalizeUrls(values);
  trace.log('handoff.normalized', { inputCount: Array.isArray(values) ? values.length : 1, validUrlCount: urls.length });
  if (!urls.length) return false;
  const accepted = await sendNative(urls, trace);
  if (accepted) {
    trace.log('handoff.native.accepted', { urlCount: urls.length });
    return true;
  }
  trace.log('handoff.native.rejected', { allowProtocolFallback });
  return allowProtocolFallback ? openProtocolFallback(urls, trace) : false;
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const automaticClick = message?.type === 'ldownload-auto-capture-click';
  if (!automaticClick && message?.type !== 'ldownload-handoff') return false;
  const trace = createTrace(automaticClick ? 'automatic-click' : 'popup');
  if (automaticClick) {
    if (!autoCaptureEnabled || typeof message.url !== 'string') {
      trace.log('page.click.ignored', { enabled: autoCaptureEnabled });
      sendResponse({ accepted: false });
      return false;
    }
    trace.log('page.click.intercepted-before-request', { origin: urlOrigin(message.url) });
  } else {
    trace.log('popup.handoff.requested', { selectedCount: Array.isArray(message.urls) ? message.urls.length : 1 });
  }
  const values = automaticClick ? message.url : message.urls;
  handoff(values, true, trace).then(accepted => {
    trace.log(automaticClick ? 'page.click.handoff.finished' : 'popup.handoff.finished', { accepted });
    sendResponse({ accepted, captureId: trace.captureId });
  }).catch(error => {
    trace.log(automaticClick ? 'page.click.handoff.failed' : 'popup.handoff.failed', { error: String(error?.message || error) });
    sendResponse({ accepted: false, captureId: trace.captureId });
  });
  return true;
});


api.contextMenus.onClicked.addListener(info => {
  const value = info.menuItemId === 'ldownload-selection' ? info.selectionText?.trim() : info.linkUrl;
  if (!value) return;
  const trace = createTrace('context-menu');
  trace.log('context-menu.requested', { menuItemId: String(info.menuItemId), origin: urlOrigin(value) });
  handoff(value, true, trace)
    .then(accepted => trace.log('context-menu.finished', { accepted }))
    .catch(error => trace.log('context-menu.failed', { error: String(error?.message || error) }));
});
