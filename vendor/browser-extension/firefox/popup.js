const api = globalThis.browser ?? globalThis.chrome;
const linksNode = document.querySelector('#links');
const statusNode = document.querySelector('#status');
const sendButton = document.querySelector('#send');
const selectButton = document.querySelector('#selectAll');
const autoCaptureInput = document.querySelector('#autoCapture');
let foundLinks = [];

api.storage.local.get({ autoCapture: false }).then(value => { autoCaptureInput.checked = Boolean(value.autoCapture); });
autoCaptureInput.addEventListener('change', async () => {
  const requestedState = autoCaptureInput.checked;
  if (requestedState) {
    // Save intent before opening the browser's permission prompt. The prompt can
    // close this popup, so the background worker must be able to finish enabling
    // capture if this page is destroyed before the request promise resolves.
    const pendingWrite = api.storage.local.set({ autoCaptureEnablePending: true, autoCaptureEnablePendingAt: Date.now() });
    let granted = false;
    try {
      // Invoke request synchronously from the checkbox gesture; awaiting any
      // operation first can make the browser reject it as lacking user intent.
      const request = api.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      const [, result] = await Promise.all([pendingWrite, request]);
      granted = result;
    }
    catch (error) {
      await pendingWrite.catch(() => {});
      await api.storage.local.set({ autoCaptureEnablePending: false, autoCaptureEnablePendingAt: 0, autoCapture: false });
      autoCaptureInput.checked = false;
      statusNode.textContent = '浏览器未授予网站权限，自动接管未启用。';
      console.warn('[LDownload capture] Site access request failed:', error);
      return;
    }
    if (!granted) {
      await api.storage.local.set({ autoCaptureEnablePending: false, autoCaptureEnablePendingAt: 0, autoCapture: false });
      autoCaptureInput.checked = false;
      statusNode.textContent = '需要授予网站访问权限，才能在请求发出前接管下载。';
      return;
    }
  }
  await api.storage.local.set({ autoCapture: requestedState, autoCaptureEnablePending: false, autoCaptureEnablePendingAt: 0 });
});


function collectPageLinks() {
  const values = new Set();
  const supported = (value) => {
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:'].includes(url.protocol) && url.host && !url.username && !url.password && url.href.length <= 8192
        ? url.href
        : null;
    } catch { return null; }
  };
  for (const node of document.querySelectorAll('a[href]')) {
    const value = supported(node.href || node.currentSrc || node.src);
    if (value) values.add(value);
    if (values.size >= 100) break;
  }
  return [...values];
}

function render() {
  linksNode.replaceChildren();
  statusNode.textContent = foundLinks.length ? `发现 ${foundLinks.length} 个链接，勾选后交给桌面下载器。` : '此页面没有发现可下载的 HTTP 或 HTTPS 链接。';
  selectButton.disabled = foundLinks.length === 0;
  sendButton.disabled = foundLinks.length === 0;
  for (const url of foundLinks) {
    const label = document.createElement('label');
    label.className = 'link';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.value = url;
    const text = document.createElement('span');
    text.textContent = url;
    label.append(checkbox, text);
    linksNode.append(label);
  }
}

async function readCurrentPage() {
  statusNode.textContent = '正在读取当前网页…';
  linksNode.replaceChildren();
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法读取当前标签页。');
    const [result] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageLinks });
    foundLinks = Array.isArray(result?.result) ? result.result : [];
    render();
  } catch (error) {
    foundLinks = [];
    statusNode.textContent = `无法读取此页面：${error.message || error}`;
    render();
  }
}

document.querySelector('#refresh').addEventListener('click', readCurrentPage);
selectButton.addEventListener('click', () => {
  const boxes = [...linksNode.querySelectorAll('input[type="checkbox"]')];
  const select = boxes.some(box => !box.checked);
  boxes.forEach(box => { box.checked = select; });
  selectButton.textContent = select ? '取消全选' : '全选';
  sendButton.disabled = !boxes.some(box => box.checked);
});
linksNode.addEventListener('change', () => {
  sendButton.disabled = !linksNode.querySelector('input[type="checkbox"]:checked');
});
sendButton.addEventListener('click', () => {
  const selected = [...linksNode.querySelectorAll('input[type="checkbox"]:checked')].map(box => box.value);
  if (!selected.length) return;
  sendButton.disabled = true;
  Promise.resolve(api.runtime.sendMessage({ type: 'ldownload-handoff', urls: selected })).then(response => {
    if (!response?.accepted) {
      statusNode.textContent = '无法打开 LDownload：请先安装原生消息主机或注册桌面链接处理程序。';
      sendButton.disabled = false;
      return;
    }
    statusNode.textContent = `已向 LDownload 发送 ${selected.length} 个链接。`;
  }).catch(error => {
    statusNode.textContent = `无法打开 LDownload：${error?.message || error || '请先安装原生消息主机或注册桌面链接处理程序。'}`;
    sendButton.disabled = false;
  });
});

readCurrentPage();
const diagnosticText = document.querySelector('#diagnosticText');
async function refreshDiagnostics() {
  try {
    const stored = await api.storage.local.get({ browserCaptureDiagnostics: [] });
    const rows = Array.isArray(stored.browserCaptureDiagnostics) ? stored.browserCaptureDiagnostics : [];
    diagnosticText.value = rows.slice(-200).map(row =>
      [row.timestamp, '[' + row.captureId + ']', row.source + '.' + row.step, row.message].join(' ')
    ).join('\n');
    if (!rows.length) diagnosticText.value = '暂无诊断记录。打开自动接管后，直接点击一个 HTTP/HTTPS 下载链接再刷新。';
  } catch (error) {
    diagnosticText.value = '读取诊断记录失败：' + (error?.message || error);
  }
}
document.querySelector('#refreshDiagnostics').addEventListener('click', refreshDiagnostics);
document.querySelector('#selectDiagnostics').addEventListener('click', () => {
  diagnosticText.focus();
  diagnosticText.select();
  diagnosticText.setSelectionRange(0, diagnosticText.value.length);
  statusNode.textContent = '诊断日志已选中，按 Ctrl+C 复制。';
});
document.querySelector('#diagnostics').addEventListener('toggle', event => {
  if (event.target.open) refreshDiagnostics();
});
