import { existsSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, Notification, screen, session, shell, Tray } from 'electron';
import type { AddDownloadInput, DownloadSettings, DownloadTask, MagnetTask, TaskLogLevel, TaskSnapshot } from '../../src/shared/contracts';
import { EngineSupervisor } from '../process/engine-supervisor';
import { queueTorrentPrompt, registerIpcHandlers } from './ipc';
import { findIncomingLink, normalizeIncomingLink } from '../core/link-parser';
import { loadDownloadInputSecrets, loadProxyCredentials, saveDownloadInputSecrets, saveProxyCredentials } from './secret-store';
import { classifyTaskError, writeApplicationLog, writeTaskLog } from './logger';
import { allTasksCompleted, updateCompletionState, type CompletionTask } from '../core/completion-state';

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();

let mainWindow: BrowserWindow | null = null;
let engine: EngineSupervisor | null = null;
let lastEngineStatus: { state: 'starting' | 'ready' | 'restarting' | 'failed'; message?: string } = { state: 'starting' };
let tray: Tray | null = null;
let quitting = false;
let closeDecisionPending = false;
let closeChoicePrompted: boolean | null = null;
let credentialRestoreWarning: string | null = null;
let receivedInitialSnapshot = false;
const previousTaskStatuses = new Map<string, string>();
const completionActionQueue: CompletionTask[] = [];
let completionActionProcessing = false;
let completionActionPrompted = false;
let pendingCompletionAction: 'exit' | 'shutdown' | null = null;
let clipboardMonitorInterval: ReturnType<typeof setInterval> | null = null;
let clipboardMonitoringEnabled = false;
let lastClipboardText: string | null = null;
let clipboardReadPending = false;
let pendingClipboardLink: string | null = null;
const loggedTaskStates = new Map<string, { status: string; error: string | null; fileName: string }>();
let cachedApplicationIcon: ReturnType<typeof nativeImage.createFromPath> | null = null;

function getApplicationIcon(): ReturnType<typeof nativeImage.createFromPath> {
  if (cachedApplicationIcon) return cachedApplicationIcon;
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon', 'app-icon.png')
    : join(app.getAppPath(), 'icon', 'app-icon.png');
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) throw new Error('无法加载应用图标：' + iconPath);
  cachedApplicationIcon = image;
  return image;
}

function logTaskChanges(snapshot: TaskSnapshot): void {
  const current = [
    ...snapshot.downloads.map(task => ({ task, kind: '普通下载' })),
    ...snapshot.magnets.map(task => ({ task, kind: '磁力下载' })),
  ];
  const present = new Set<string>();
  for (const { task, kind } of current) {
    present.add(task.id);
    const previous = loggedTaskStates.get(task.id);
    if (!previous) {
      const isRecent = Date.now() - task.createdAt < 60_000;
      const initialCode = task.status === 'failed' && task.error ? classifyTaskError(task.error) : isRecent ? 'TASK_CREATED' : 'TASK_STATE_ON_START';
      const initialMessage = isRecent ? kind + '任务已创建：' + task.fileName : kind + '当前状态：' + task.status + (task.error ? '；' + task.error : '');
      writeTaskLog(task.id, task.status === 'failed' ? 'error' : 'info', initialCode, initialMessage);
    } else if (previous.status !== task.status) {
      const level: TaskLogLevel = task.status === 'failed' ? 'error' : 'info';
      const code = task.status === 'failed' && task.error ? classifyTaskError(task.error) : 'TASK_STATUS_' + task.status.toUpperCase();
      writeTaskLog(task.id, level, code, kind + '状态变为：' + task.status + (task.error ? '；' + task.error : ''));
    }
    if (task.error && task.error !== previous?.error && task.status !== 'failed') {
      writeTaskLog(task.id, 'error', classifyTaskError(task.error), task.error);
    }
    loggedTaskStates.set(task.id, { status: task.status, error: task.error, fileName: task.fileName });
  }
  for (const [id, previous] of loggedTaskStates) {
    if (!present.has(id)) {
      writeTaskLog(id, 'info', 'TASK_REMOVED', '任务已从列表移除：' + previous.fileName);
      loggedTaskStates.delete(id);
    }
  }
}
type BrowserTraceEntry = { step: string; message: string };
type IncomingDeepLink = { url: string; autoStart: boolean; captureId?: string | undefined; trace?: BrowserTraceEntry[] };
const pendingDeepLinks: IncomingDeepLink[] = [];
const pendingTorrentFiles: string[] = [];
const queuedTorrentFiles = new Set<string>();
let torrentImportProcessing = false;

function logBrowserCapture(captureId: string | undefined, stage: string, message: string, level: TaskLogLevel = 'info'): Promise<void> {
  return writeApplicationLog(level, 'BROWSER_CAPTURE_' + stage, (captureId ? '[' + captureId + '] ' : '') + message);
}

function browserCaptureUrlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname + (url.search ? '?[query redacted]' : '');
  } catch { return '[invalid URL]'; }
}

function validCaptureId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{8,80}$/i.test(value);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(getApplicationIcon().resize({ width: 32, height: 32 })); tray.setToolTip('LDownload');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 LDownload', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}


function queueDeepLink(raw: string, autoStart = false, captureId?: string): void {
  const url = normalizeIncomingLink(raw);
  if (!url) {
    logBrowserCapture(captureId, 'LINK_REJECTED', '深链接未包含可接受的下载 URL。', 'warn');
    return;
  }
  logBrowserCapture(captureId, 'LINK_QUEUED', '收到 ' + browserCaptureUrlLabel(url) + '；autoStart=' + autoStart + '。');
  pendingDeepLinks.push({ url, autoStart, captureId });
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
    showMainWindow();
    setImmediate(flushDeepLinks);
  }
}

function parseBrowserTrace(value: string | null): BrowserTraceEntry[] {
  if (!value || value.length > 24_000) return [];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-40).flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as { step?: unknown; message?: unknown };
      if (typeof row.step !== 'string' || !/^[a-z0-9._-]{1,64}$/i.test(row.step)) return [];
      return [{ step: row.step, message: typeof row.message === 'string' ? row.message.slice(0, 500) : '' }];
    });
  } catch { return []; }
}

function findIncomingRequest(arguments_: Iterable<string>): IncomingDeepLink[] {
  for (const argument of arguments_) {
    try {
      const protocolUrl = new URL(argument);
      if (protocolUrl.protocol === 'ldownload:') {
        const rawUrls = protocolUrl.searchParams.getAll('url');
        if (!rawUrls.length) {
          const fallback = protocolUrl.searchParams.get('link');
          if (fallback) rawUrls.push(fallback);
        }
        const candidate = protocolUrl.searchParams.get('captureId');
        const captureId = validCaptureId(candidate) ? candidate : undefined;
        const autoStart = protocolUrl.searchParams.get('autoStart') === '1' && !captureId;
        const trace = parseBrowserTrace(protocolUrl.searchParams.get('trace'));
        const incoming = rawUrls.flatMap(raw => {
          const url = normalizeIncomingLink(raw);
          return url ? [{ url, autoStart, captureId, ...(trace.length ? { trace } : {}) }] : [];
        });
        if (incoming.length) return incoming;
        continue;
      }
    } catch { /* The normalized URL can also be supplied directly. */ }
    const url = normalizeIncomingLink(argument);
    if (url) return [{ url, autoStart: false }];
  }
  return [];
}

function findIncomingTorrentFiles(arguments_: Iterable<string>): string[] {
  const files = new Set<string>();
  for (const argument of arguments_) {
    const value = argument.trim().replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(value) || extname(value).toLowerCase() !== '.torrent') continue;
    files.add(resolve(value));
  }
  return [...files];
}

function findIncomingTraceUpload(arguments_: Iterable<string>): { captureId?: string; trace: BrowserTraceEntry[] } | null {
  for (const argument of arguments_) {
    try {
      const protocolUrl = new URL(argument);
      if (protocolUrl.protocol !== 'ldownload:' || protocolUrl.hostname !== 'diagnostics') continue;
      const candidate = protocolUrl.searchParams.get('captureId');
      return {
        ...(validCaptureId(candidate) ? { captureId: candidate } : {}),
        trace: parseBrowserTrace(protocolUrl.searchParams.get('trace')),
      };
    } catch { /* Other command-line arguments are not diagnostic uploads. */ }
  }
  return null;
}

async function recordBrowserTrace(captureId: string | undefined, trace: BrowserTraceEntry[], source: string): Promise<void> {
  await logBrowserCapture(captureId, 'DIAGNOSTIC_UPLOAD_RECEIVED', source + ' 接收了 ' + trace.length + ' 条扩展诊断记录。');
  for (const entry of trace) {
    await logBrowserCapture(captureId, 'EXTENSION_' + entry.step.toUpperCase(), entry.message);
  }
}

async function migrateNativeMessagingHost(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const manifestPath = join(app.getPath('userData'), 'browser-native-host', 'org.ldownload1.browser.json');
  const hostPath = join(process.resourcesPath, 'browser-native-host', 'LDownloadNativeHost.exe');
  if (!existsSync(manifestPath) || !existsSync(hostPath)) return;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.name !== 'org.ldownload1.browser') return;
    if (manifest.path === hostPath && !('args' in manifest)) return;
    manifest.path = hostPath;
    delete manifest.args;
    const temporary = manifestPath + '.tmp';
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, manifestPath);
    await writeApplicationLog('info', 'BROWSER_NATIVE_HOST_MIGRATED', '已将浏览器原生消息主机切换到独立二进制宿主。');
  } catch (error) {
    await writeApplicationLog('error', 'BROWSER_NATIVE_HOST_MIGRATION_FAILED', error instanceof Error ? error.message : String(error));
  }
}

function startIncomingDownload(url: string, captureId?: string): void {
  logBrowserCapture(captureId, 'ENGINE_REQUEST_START', '等待下载引擎就绪：' + browserCaptureUrlLabel(url));
  const current = engine;
  if (!current) {
    logBrowserCapture(captureId, 'ENGINE_NOT_READY', '下载引擎尚未创建，将链接重新排队。', 'warn');
    pendingDeepLinks.unshift({ url, autoStart: true, captureId });
    return;
  }
  void (async () => {
    await current.waitUntilReady();
    logBrowserCapture(captureId, 'TASK_ADD_SENT', '引擎已就绪，正在调用 tasks:add。');
    const task = await current.request<DownloadTask>('tasks:add', { url });
    logBrowserCapture(captureId, 'TASK_CREATED', '任务已创建：' + task.id + '；文件名=' + task.fileName + '；状态=' + task.status + '。');
    writeApplicationLog('info', 'BROWSER_AUTO_CAPTURE_STARTED', '已创建浏览器接管下载任务：' + task.fileName);
  })().catch(error => {
    const reason = error instanceof Error ? error.message : String(error);
    logBrowserCapture(captureId, 'TASK_CREATE_FAILED', browserCaptureUrlLabel(url) + '；' + reason, 'error');
    writeApplicationLog('error', 'BROWSER_AUTO_CAPTURE_FAILED', reason);
    if (Notification.isSupported()) new Notification({ title: 'LDownload', body: '浏览器下载接管失败：' + reason.slice(0, 180) }).show();
  });
}

function queueTorrentFile(rawPath: string): void {
  const candidate = rawPath.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(candidate) || extname(candidate).toLowerCase() !== '.torrent') {
    void writeApplicationLog('warn', 'TORRENT_OPEN_REJECTED', '系统传入的文件不是绝对路径 .torrent 文件。');
    return;
  }
  const torrentPath = resolve(candidate);
  const key = torrentPath.toLowerCase();
  if (queuedTorrentFiles.has(key)) return;
  queuedTorrentFiles.add(key);
  pendingTorrentFiles.push(torrentPath);
  void writeApplicationLog('info', 'TORRENT_OPEN_RECEIVED', '收到种子文件打开请求：' + torrentPath);
  if (engine) void flushIncomingTorrentFiles();
}

async function flushIncomingTorrentFiles(): Promise<void> {
  if (!engine || torrentImportProcessing) return;
  torrentImportProcessing = true;
  try {
    while (pendingTorrentFiles.length && engine) {
      const torrentPath = pendingTorrentFiles.shift()!;
      const key = torrentPath.toLowerCase();
      try {
        const file = await stat(torrentPath);
        if (!file.isFile() || file.size > 16 * 1024 * 1024) throw new Error('种子文件不是普通文件或超过 16 MiB。');
        const current = engine;
        await current.waitUntilReady();
        const task = await current.request<MagnetTask>('tasks:import-torrent', { torrentPath });
        await writeApplicationLog('info', 'TORRENT_OPEN_TASK_CREATED', '已导入并启动种子任务：' + task.fileName + '；任务编号=' + task.id);
        showMainWindow();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeApplicationLog('error', 'TORRENT_OPEN_FAILED', torrentPath + '；' + message);
        showMainWindow();
        if (Notification.isSupported()) new Notification({ title: 'LDownload', body: '打开种子文件失败：' + message.slice(0, 180) }).show();
      } finally {
        queuedTorrentFiles.delete(key);
      }
    }
  } finally {
    torrentImportProcessing = false;
    if (pendingTorrentFiles.length && engine) void flushIncomingTorrentFiles();
  }
}

function flushDeepLinks(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return;
  for (const incoming of pendingDeepLinks.splice(0, 100)) {
    if (incoming.autoStart) {
      logBrowserCapture(incoming.captureId, 'LINK_DISPATCHED', '自动创建下载任务。');
      startIncomingDownload(incoming.url, incoming.captureId);
    } else {
      logBrowserCapture(incoming.captureId, incoming.captureId ? 'CONFIRMATION_REQUIRED' : 'LINK_DISPATCHED', incoming.captureId ? '浏览器链接已送到新建任务弹窗；用户确认前不会调用下载引擎。' : '转交界面确认创建下载任务。');
      mainWindow.webContents.send('system:open-link', { url: incoming.url });
    }
  }
}


function flushPendingClipboardLink(): void {
  if (!pendingClipboardLink || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return;
  const url = pendingClipboardLink;
  pendingClipboardLink = null;
  mainWindow.webContents.send('system:clipboard-link', { url });
}

function flushPendingCompletionAction(): void {
  if (!pendingCompletionAction || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return;
  const action = pendingCompletionAction;
  pendingCompletionAction = null;
  mainWindow.webContents.send('downloads:completion-action-required', { action });
}

function publishClipboardLink(url: string): void {
  pendingClipboardLink = url;
  showMainWindow();
  flushPendingClipboardLink();
}

function recordClipboardWrite(text: string): void {
  if (clipboardMonitoringEnabled) lastClipboardText = text.slice(0, 32_768);
}

function setClipboardMonitoring(enabled: boolean): void {
  if (!enabled) {
    if (clipboardMonitorInterval) clearInterval(clipboardMonitorInterval);
    clipboardMonitorInterval = null;
    clipboardMonitoringEnabled = false;
    lastClipboardText = null;
    return;
  }
  if (clipboardMonitorInterval) return;
  clipboardMonitoringEnabled = true;
  void clipboard.readText().then(text => {
    if (clipboardMonitoringEnabled) lastClipboardText = text.slice(0, 32_768);
  }).catch(() => { if (clipboardMonitoringEnabled) lastClipboardText = ''; });
  clipboardMonitorInterval = setInterval(() => {
    if (!clipboardMonitoringEnabled || clipboardReadPending) return;
    clipboardReadPending = true;
    void clipboard.readText().then(rawText => {
      if (!clipboardMonitoringEnabled) return;
      const text = rawText.slice(0, 32_768);
      if (text === lastClipboardText) return;
      lastClipboardText = text;
      const url = findIncomingLink(text.split(/\s+/));
      if (url) publishClipboardLink(url);
    }).catch(() => undefined).finally(() => { clipboardReadPending = false; });
  }, 1000);
  clipboardMonitorInterval.unref();
}
function queueCompletionActionPrompt(action: 'exit' | 'shutdown'): void {
  if (completionActionPrompted) return;
  completionActionPrompted = true;
  pendingCompletionAction = action;
  showMainWindow();
  flushPendingCompletionAction();
}

async function processCompletionActionQueue(): Promise<void> {
  if (completionActionProcessing || !engine) return;
  completionActionProcessing = true;
  try {
    while (completionActionQueue.length) {
      const task = completionActionQueue.shift()!;
      const current = engine;
      if (!current) return;
      const settings = await current.request<DownloadSettings>('tasks:download-settings');
      const action = settings.completionAction;
      if (action === 'open_file' || action === 'open_folder') {
        const target = action === 'open_folder'
          ? task.kind === 'magnet' ? join(task.directory, task.fileName) : task.directory
          : join(task.directory, task.fileName);
        if (!existsSync(target)) {
          writeApplicationLog('warn', 'COMPLETION_TARGET_MISSING', '完成后的目标路径不存在：' + target);
          continue;
        }
        const error = await shell.openPath(target);
        if (error) writeApplicationLog('error', 'COMPLETION_OPEN_FAILED', error);
        continue;
      }
      if ((action === 'exit' || action === 'shutdown') && !completionActionPrompted) {
        const latest = current.currentSnapshot();
        if (allTasksCompleted(latest.downloads, latest.magnets)) queueCompletionActionPrompt(action);
      }
    }
  } catch (error) {
    writeApplicationLog('error', 'COMPLETION_ACTION_FAILED', error instanceof Error ? error.message : String(error));
  } finally {
    completionActionProcessing = false;
  }
}

function notifyCompletedDownloads(snapshot: TaskSnapshot): void {
  const result = updateCompletionState(
    snapshot.downloads.map(task => ({ ...task, kind: 'ordinary' as const })),
    snapshot.magnets.map(task => ({ ...task, kind: 'magnet' as const })),
    previousTaskStatuses,
  );
  if (!receivedInitialSnapshot) { receivedInitialSnapshot = true; return; }
  if (!result.allCompleted) completionActionPrompted = false;
  for (const task of result.newlyCompleted) {
    if (Notification.isSupported()) new Notification({ title: 'LDownload', body: '下载完成：' + task.fileName }).show();
    if (task.kind === 'ordinary' && extname(task.fileName).toLowerCase() === '.torrent') {
      // Bring the existing torrent selection dialog to the foreground only
      // after the file is fully committed and the ordinary task is complete.
      showMainWindow();
      queueTorrentPrompt(resolve(task.directory, task.fileName));
    }
    completionActionQueue.push(task);
  }
  if (result.newlyCompleted.length) void processCompletionActionQueue();
}
function sendEngineStatus(state: 'starting' | 'ready' | 'restarting' | 'failed', message?: string): void {
  if (lastEngineStatus.state !== state || lastEngineStatus.message !== message) {
    const level: TaskLogLevel = state === 'failed' ? 'error' : state === 'restarting' ? 'warn' : 'info';
    writeApplicationLog(level, 'ENGINE_' + state.toUpperCase(), message || '下载引擎状态：' + state);
  }
  lastEngineStatus = { state, ...(message ? { message } : {}) };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine:status', { state, message });
}

function initialWindowBounds(): { x: number; y: number; width: number; height: number; minWidth: number; minHeight: number } {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.size;
  const { x: workX, y: workY, width: workWidth, height: workHeight } = display.workArea;
  const scale = Math.min(screenWidth / 1920, screenHeight / 1080);
  const maxWidth = Math.max(320, Math.floor(workWidth * 0.9));
  const maxHeight = Math.max(320, Math.floor(workHeight * 0.9));
  const minWidth = 1200;
  const minHeight = Math.min(640, maxHeight);
  const width = Math.max(minWidth, Math.min(maxWidth, Math.round(1440 * 0.9 * scale)));
  const height = Math.min(maxHeight, Math.max(minHeight, Math.round(960 * 0.9 * scale)));
  return {
    x: Math.round(workX + (workWidth - width) / 2),
    y: Math.round(workY + (workHeight - height) / 2),
    width, height, minWidth, minHeight: Math.min(minHeight, height),
  };
}

async function closePromptWasShown(): Promise<boolean> {
  if (closeChoicePrompted !== null) return closeChoicePrompted;
  try {
    const saved = JSON.parse(await readFile(join(app.getPath('userData'), 'close-choice.json'), 'utf8')) as { prompted?: unknown };
    closeChoicePrompted = saved.prompted === true;
  } catch { closeChoicePrompted = false; }
  return closeChoicePrompted;
}

async function rememberClosePrompt(): Promise<void> {
  closeChoicePrompted = true;
  try { await writeFile(join(app.getPath('userData'), 'close-choice.json'), JSON.stringify({ prompted: true }), 'utf8'); }
  catch (error) { writeApplicationLog('warn', 'CLOSE_CHOICE_SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
}

async function handleWindowClose(window: BrowserWindow): Promise<void> {
  const currentEngine = engine;
  if (!currentEngine || quitting) return;
  const settings = await currentEngine.request<DownloadSettings>('tasks:download-settings');
  let minimizeToTray = settings.minimizeToTray;
  if (!(await closePromptWasShown())) {
    const english = settings.language === 'en-US';
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: english ? 'Close LDownload' : '关闭 LDownload',
      message: english ? 'What should happen when you close the window?' : '关闭窗口时要如何处理？',
      detail: english ? 'Minimizing keeps downloads running in the system tray.' : '最小化到系统托盘可以让下载继续运行。',
      buttons: english ? ['Minimize to tray', 'Exit', 'Cancel'] : ['最小化到系统托盘', '直接退出', '取消'],
      defaultId: 0, cancelId: 2, noLink: true,
    });
    if (result.response === 2) return;
    minimizeToTray = result.response === 0;
    await currentEngine.request<DownloadSettings>('tasks:update-download-settings', { minimizeToTray });
    await rememberClosePrompt();
  }
  if (window.isDestroyed() || quitting) return;
  if (minimizeToTray) { createTray(); window.hide(); }
  else { quitting = true; app.quit(); }
}

function createWindow(): BrowserWindow {
  const bounds = initialWindowBounds();
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    show: false,
    backgroundColor: '#f6f8fc',
    icon: getApplicationIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    let isAllowed = false;
    try {
      const target = new URL(targetUrl);
      isAllowed = devUrl
        ? target.origin === new URL(devUrl).origin && target.pathname === new URL(devUrl).pathname
        : target.href === pathToFileURL(join(__dirname, '../renderer/index.html')).href;
    } catch { /* Invalid navigation stays blocked. */ }
    if (!isAllowed) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('maximize', () => { if (!window.isDestroyed()) window.webContents.send('window:maximized-changed', true); });
  window.on('unmaximize', () => { if (!window.isDestroyed()) window.webContents.send('window:maximized-changed', false); });
  window.on('close', event => {
    if (quitting || !engine) return;
    event.preventDefault();
    if (closeDecisionPending) return;
    closeDecisionPending = true;
    void handleWindowClose(window).catch(error => {
      writeApplicationLog('error', 'WINDOW_CLOSE_DECISION_FAILED', error instanceof Error ? error.message : String(error));
      if (!window.isDestroyed() && !quitting) { quitting = true; app.quit(); }
    }).finally(() => { closeDecisionPending = false; });
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });

  window.webContents.once('did-finish-load', () => {
    flushDeepLinks();
    flushPendingClipboardLink();
    flushPendingCompletionAction();
    if (!engine || window.isDestroyed()) return;
    const snapshot = engine.currentSnapshot();
    window.webContents.send('downloads:updated', snapshot.downloads);
    window.webContents.send('magnets:updated', snapshot.magnets);
    window.webContents.send('engine:status', lastEngineStatus);
    window.webContents.send('window:maximized-changed', window.isMaximized());
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
}

app.on('second-instance', (_event, commandLine) => {
  const upload = findIncomingTraceUpload(commandLine);
  if (upload) {
    void recordBrowserTrace(upload.captureId, upload.trace, '第二实例诊断转交').catch(error =>
      writeApplicationLog('error', 'BROWSER_CAPTURE_DIAGNOSTIC_WRITE_FAILED', error instanceof Error ? error.message : String(error)));
    return;
  }
  const incomingTorrentFiles = findIncomingTorrentFiles(commandLine);
  for (const filePath of incomingTorrentFiles) queueTorrentFile(filePath);
  const incoming = findIncomingRequest(commandLine);
  if (incoming.length) {
    const first = incoming[0]!;
    const trace = incoming.find(item => item.trace)?.trace;
    if (trace) void recordBrowserTrace(first.captureId, trace, '原生宿主转交').catch(error =>
      writeApplicationLog('error', 'BROWSER_CAPTURE_DIAGNOSTIC_WRITE_FAILED', error instanceof Error ? error.message : String(error)));
    void logBrowserCapture(first.captureId, 'SECOND_INSTANCE_RECEIVED', '收到 ' + incoming.length + ' 个下载 URL；autoStart=' + first.autoStart + '。');
    for (const item of incoming) queueDeepLink(item.url, item.autoStart, item.captureId);
  } else if (!incomingTorrentFiles.length) {
    void logBrowserCapture(undefined, 'SECOND_INSTANCE_NO_LINK', '第二实例启动参数中没有识别到下载链接或种子文件。', 'warn');
  }
  showMainWindow();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  const upload = findIncomingTraceUpload([url]);
  if (upload) {
    void recordBrowserTrace(upload.captureId, upload.trace, '系统协议诊断转交').catch(error =>
      writeApplicationLog('error', 'BROWSER_CAPTURE_DIAGNOSTIC_WRITE_FAILED', error instanceof Error ? error.message : String(error)));
    return;
  }
  const incoming = findIncomingRequest([url]);
  if (incoming.length) {
    const trace = incoming.find(item => item.trace)?.trace;
    if (trace) void recordBrowserTrace(incoming[0]!.captureId, trace, '系统协议转交').catch(error =>
      writeApplicationLog('error', 'BROWSER_CAPTURE_DIAGNOSTIC_WRITE_FAILED', error instanceof Error ? error.message : String(error)));
    for (const item of incoming) queueDeepLink(item.url, item.autoStart, item.captureId);
    if (app.isReady()) showMainWindow();
  } else {
    void logBrowserCapture(undefined, 'OPEN_URL_REJECTED', '系统协议 URL 未通过链接识别。', 'warn');
    if (app.isReady()) showMainWindow();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (process.platform === 'darwin') app.dock?.setIcon(getApplicationIcon());
  if (!hasSingleInstance) return;
  await migrateNativeMessagingHost();
  try { await session.defaultSession.setProxy({ mode: 'system' }); }
  catch (error) { writeApplicationLog('warn', 'SYSTEM_PROXY_CONFIG_FAILED', error instanceof Error ? error.message : String(error)); }
  app.setAppUserModelId('com.ldownload.desktop');
  const executable = app.isPackaged ? undefined : process.execPath;
  const protocolArgs = app.isPackaged ? undefined : [app.getAppPath()];
  app.setAsDefaultProtocolClient('ldownload', executable, protocolArgs);
  app.setAsDefaultProtocolClient('magnet', executable, protocolArgs);
  const initialUpload = findIncomingTraceUpload(process.argv);
  if (initialUpload) await recordBrowserTrace(initialUpload.captureId, initialUpload.trace, '主进程启动参数');
  const initialTorrentFiles = findIncomingTorrentFiles(process.argv);
  for (const filePath of initialTorrentFiles) queueTorrentFile(filePath);
  const initialLinks = findIncomingRequest(process.argv);
  if (initialLinks.length) {
    const first = initialLinks[0]!;
    const trace = initialLinks.find(item => item.trace)?.trace;
    if (trace) await recordBrowserTrace(first.captureId, trace, '主进程启动参数');
    for (const incoming of initialLinks) {
      logBrowserCapture(incoming.captureId, 'INITIAL_LINK_RECEIVED', '收到启动参数链接；autoStart=' + incoming.autoStart + '。');
      queueDeepLink(incoming.url, incoming.autoStart, incoming.captureId);
    }
  }
  engine = new EngineSupervisor(
    (state, message) => sendEngineStatus(state, message),
    snapshot => {
      logTaskChanges(snapshot);
      notifyCompletedDownloads(snapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('downloads:updated', snapshot.downloads);
        mainWindow.webContents.send('magnets:updated', snapshot.magnets);
      }
    },
    async () => {
      const current = engine;
      if (!current) return;
      let legacy: Record<string, Partial<AddDownloadInput>> = {};
      try { legacy = await current.request<Record<string, Partial<AddDownloadInput>>>('tasks:export-input-secrets'); }
      catch (error) { credentialRestoreWarning = '无法迁移旧下载凭据：' + (error instanceof Error ? error.message : String(error)); }
      let legacyProxy: { username?: string | null; password?: string | null } = {};
      try { legacyProxy = await current.request('tasks:export-proxy-secrets'); }
      catch { /* Older worker state may not contain proxy settings. */ }
      try {
        const storedProxy = await loadProxyCredentials();
        if (!storedProxy.username && legacyProxy.username) await saveProxyCredentials({ username: legacyProxy.username, password: legacyProxy.password ?? null });
      } catch (error) { credentialRestoreWarning = '无法迁移加密的代理凭据：' + (error instanceof Error ? error.message : String(error)); }
      try { await current.request('tasks:set-proxy-credentials', await loadProxyCredentials()); }
      catch (error) { credentialRestoreWarning = '无法恢复代理凭据：' + (error instanceof Error ? error.message : String(error)); }
      try {
        for (const [id, secret] of Object.entries(legacy)) await saveDownloadInputSecrets(id, secret);
      } catch (error) {
        credentialRestoreWarning = '系统凭据加密不可用；本次运行仍保留旧凭据，但它们不会跨重启保存。';
      }
      let stored: Record<string, Partial<AddDownloadInput>> = {};
      try { stored = await loadDownloadInputSecrets(); }
      catch (error) { credentialRestoreWarning = '无法读取系统加密的下载凭据：' + (error instanceof Error ? error.message : String(error)); }
      try { await current.request('tasks:restore-input-secrets', { secrets: { ...legacy, ...stored } }); }
      catch (error) { credentialRestoreWarning = '无法恢复下载凭据：' + (error instanceof Error ? error.message : String(error)); }
    },
    event => {
      writeApplicationLog(event.level, event.code, event.message);
      if (event.taskId) writeTaskLog(event.taskId, event.level, event.code, event.message);
    },
  );
  engine.start();
  createTray();
  try {
    await engine.waitUntilReady();
  } catch (error) {
    sendEngineStatus('failed', error instanceof Error ? error.message : String(error));
  }
  if (credentialRestoreWarning) sendEngineStatus('ready', credentialRestoreWarning);
  mainWindow = createWindow();
  registerIpcHandlers(engine, () => mainWindow, setClipboardMonitoring, recordClipboardWrite);
  void flushIncomingTorrentFiles();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueTorrentFile(filePath);
  if (app.isReady()) showMainWindow();
});

app.on('before-quit', () => {
  quitting = true;
  if (clipboardMonitorInterval) clearInterval(clipboardMonitorInterval);
  clipboardMonitorInterval = null;
  clipboardMonitoringEnabled = false;
  engine?.stop();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

