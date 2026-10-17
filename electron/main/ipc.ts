import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  app, clipboard, dialog, ipcMain, shell,
  type BrowserWindow, type IpcMainInvokeEvent,
} from 'electron';
import type {
  CollectionSnapshot, DownloadMetadata, DownloadSettings, DownloadTask, EngineCapabilities, MagnetFilePreview, MagnetSettings, MagnetTask, SiteCollectionProject,
  TaskSnapshot,
} from '../../src/shared/contracts';
import type { IpcChannel, IpcRequestMap, IpcResponseMap } from '../../src/shared/ipc';
import { EngineSupervisor } from '../process/engine-supervisor';
import { validateDownloadInputShape } from '../core/download-input';
import { findVerifiedSdkDirectory } from '../engines/thunder/thunder-sdk';
import { runSiteCollection } from '../core/site-collector';
import { loadProxyCredentials, removeDownloadInputSecrets, saveDownloadInputSecrets, saveProxyCredentials } from './secret-store';
import { readTaskLogs, writeApplicationLog } from './logger';

const runFile = promisify(execFile);

/**
 * Resolve reg.exe from the Windows system directory instead of relying on PATH.
 * Packaged Electron apps can be started with a restricted/incomplete PATH (for
 * example through a shortcut or another app), which makes spawn('reg.exe') fail
 * with ENOENT even though the Windows registry utility is installed.
 */
function resolveRegistryExecutable(): string {
  const roots = [...new Set([process.env.SystemRoot, process.env.WINDIR, 'C:\\Windows'].filter((value): value is string => Boolean(value)))];
  const directories = process.arch === 'ia32'
    ? ['Sysnative', 'System32', 'SysWOW64']
    : ['System32', 'Sysnative', 'SysWOW64'];
  const candidate = roots.flatMap(root => directories.map(directory => join(root, directory, 'reg.exe'))).find(existsSync);
  if (!candidate) throw new Error('找不到 Windows 系统工具 reg.exe，请检查 Windows 系统目录配置。');
  return candidate;
}

const approvedFiles = new Set<string>();
const approvedDirectories = new Set<string>();
const pendingTorrentPrompts: string[] = [];
const pendingTorrentPromptKeys = new Set<string>();
const projects = new Map<string, SiteCollectionProject>();
const collectionControllers = new Map<string, AbortController>();
let collectionRevision = 0;
let collectionLoad: Promise<void> | null = null;
let collectionWrite = Promise.resolve();

function ensureCollectionsLoaded(): Promise<void> {
  if (!collectionLoad) {
    collectionLoad = (async () => {
      try {
        const value = JSON.parse(await readFile(join(app.getPath('userData'), 'site-collections.json'), 'utf8'));
        if (!Array.isArray(value)) throw new Error('网页采集项目文件格式无效');
        for (const item of value) {
          if (item && typeof item.id === 'string' && Array.isArray(item.frontier) &&
              Array.isArray(item.visitedPages) && Array.isArray(item.foundLinks)) projects.set(item.id, item as SiteCollectionProject);
        }
        collectionRevision++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    })();
  }
  return collectionLoad;
}

function persistCollections(): Promise<void> {
  const target = join(app.getPath('userData'), 'site-collections.json');
  const temporary = target + '.tmp';
  const serialized = JSON.stringify(sortedProjects());
  collectionWrite = collectionWrite.catch(() => undefined).then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  });
  return collectionWrite;
}
let getCurrentWindow: () => BrowserWindow | null = () => null;

/** Queue completed torrent downloads until the renderer can present its normal
 * file-selection dialog. The queue survives hidden/minimized windows and is
 * drained atomically by system:take-torrent-prompts. */
export function queueTorrentPrompt(torrentPath: string): void {
  if (extname(torrentPath).toLowerCase() !== '.torrent') return;
  const normalizedPath = resolve(torrentPath);
  const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  if (pendingTorrentPromptKeys.has(key)) return;
  pendingTorrentPromptKeys.add(key);
  pendingTorrentPrompts.push(normalizedPath);
  const window = getCurrentWindow();
  if (window && !window.isDestroyed()) window.webContents.send('system:torrent-prompt-available');
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const mainWindow = getCurrentWindow();
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('拒绝来自非主窗口的 IPC 请求');
  }
}

function register<K extends IpcChannel>(
  channel: K,
  handler: (payload: IpcRequestMap[K]) => IpcResponseMap[K] | Promise<IpcResponseMap[K]>,
): void {
  ipcMain.handle(channel, async (event, payload: IpcRequestMap[K]) => {
    assertTrustedSender(event);
    try { return await handler(payload); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeApplicationLog('error', 'IPC_HANDLER_FAILED', channel + ': ' + message);
      throw error;
    }
  });
}

function publishCollections(snapshot: CollectionSnapshot): void {
  const mainWindow = getCurrentWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('site-collections:updated', snapshot);
}

function sortedProjects(): SiteCollectionProject[] {
  return [...projects.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function collectionSnapshot(): CollectionSnapshot {
  return { revision: collectionRevision, projects: sortedProjects() };
}

function updateCollection(project: SiteCollectionProject): SiteCollectionProject[] {
  project.updatedAt = Date.now();
  projects.set(project.id, project);
  collectionRevision++;
  publishCollections(collectionSnapshot());
  void persistCollections().catch(error => console.error('Could not save site collection projects:', error));
  return sortedProjects();
}

function validateDownloadInput(input: unknown): import('../../src/shared/contracts').AddDownloadInput {
  const validated = validateDownloadInputShape(input);
  assertApprovedDirectory(validated.directory);
  return validated;
}
function normalizedDirectory(value: string): string { return resolve(value).toLowerCase(); }

function assertApprovedDirectory(value: unknown): void {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || value.length > 4096 || !approvedDirectories.has(normalizedDirectory(value))) {
    throw new Error('保存目录必须先通过系统文件夹选择器确认');
  }
}

function assertWebUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入有效的网页地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('链接收集只接受不含内嵌凭据的 HTTP 或 HTTPS 地址');
  }
  return url;
}

export function registerIpcHandlers(
  engine: EngineSupervisor,
  getWindow: () => BrowserWindow | null,
  onClipboardMonitorChanged: (enabled: boolean) => void = () => undefined,
  onClipboardWritten: (text: string) => void = () => undefined,
): void {
  getCurrentWindow = getWindow;
  approvedDirectories.add(normalizedDirectory(app.getPath('downloads')));
  const worker = <T = void>(method: Parameters<EngineSupervisor['request']>[0], payload?: unknown): Promise<T> => engine.request<T>(method, payload);
  const snapshot = (): TaskSnapshot => engine.currentSnapshot();
  const isCompletedDownloadedTorrent = (torrentPath: string): boolean => {
    if (typeof torrentPath !== 'string' || extname(torrentPath).toLowerCase() !== '.torrent') return false;
    const candidate = resolve(torrentPath);
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    return snapshot().downloads.some(task => {
      if (task.status !== 'completed' || extname(task.fileName).toLowerCase() !== '.torrent') return false;
      const taskPath = resolve(task.directory, task.fileName);
      return (process.platform === 'win32' ? taskPath.toLowerCase() : taskPath) === key;
    });
  };

  register('downloads:list', async () => (await worker<TaskSnapshot>('tasks:list')).downloads);
  register('downloads:task-logs', ({ id }) => {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error('任务编号无效');
    return readTaskLogs(id, 500);
  });
  register('downloads:inspect-url', input => worker<DownloadMetadata>('tasks:inspect-url', validateDownloadInput(input)));
  register('downloads:add', async input => {
    const value = validateDownloadInput(input);
    const taskId = randomUUID();
    await saveDownloadInputSecrets(taskId, value);
    try { return await worker<DownloadTask>('tasks:add', { ...value, taskId }); }
    catch (error) { await removeDownloadInputSecrets(taskId).catch(() => undefined); throw error; }
  });
  register('downloads:pause', ({ id }) => worker<void>('tasks:pause', { id }));
  register('downloads:resume', ({ id }) => worker<void>('tasks:resume', { id }));
  register('downloads:resume-order', ({ ids }) => worker<string[]>('tasks:resume-order', { ids }));
  register('downloads:start-all', ({ taskIds }) => {
    if (!Array.isArray(taskIds) || taskIds.length > 100_000 || taskIds.some(id => typeof id !== 'string' || id.length > 100)) throw new Error('任务排序数据无效');
    return worker<void>('tasks:start-all', { taskIds });
  });
  register('downloads:pause-all', ({ taskIds }) => {
    if (!Array.isArray(taskIds) || taskIds.length > 100_000 || taskIds.some(id => typeof id !== 'string' || id.length > 100)) throw new Error('任务暂停数据无效');
    return worker<void>('tasks:pause-all', { taskIds });
  });
  register('window:minimize', () => { getWindow()?.minimize(); });
  register('window:toggle-maximize', () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
  });
  register('window:close', () => { getWindow()?.close(); });
  register('window:is-maximized', () => Boolean(getWindow()?.isMaximized()));
  register('downloads:remove', async ({ id, deleteFiles }) => {
    await worker<void>('tasks:remove', { id, deleteFiles });
    await removeDownloadInputSecrets(id);
  });
  register('downloads:set-category', ({ id, category }) => worker<void>('tasks:set-category', { id, category }));
  register('downloads:set-queue', ({ id, queueName }) => worker<void>('tasks:set-queue', { id, queueName }));
  register('downloads:settings', async () => {
    const settings = await worker<DownloadSettings>('tasks:download-settings');
    onClipboardMonitorChanged(settings.clipboardMonitorEnabled);
    const proxy = await loadProxyCredentials().catch(() => ({ username: null, password: null }));
    if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    if (settings.defaultDownloadDirectory) approvedDirectories.add(normalizedDirectory(settings.defaultDownloadDirectory));
    return { ...settings, proxyUsername: proxy.username };
  });
  register('downloads:update-settings', async request => {
    const { proxyPassword, ...settingsUpdate } = request;
    const update = { ...settingsUpdate };
    if (update.defaultDownloadDirectory != null) assertApprovedDirectory(update.defaultDownloadDirectory);
    if (update.maxConcurrentDownloads !== undefined && (!Number.isInteger(update.maxConcurrentDownloads) || update.maxConcurrentDownloads < 1 || update.maxConcurrentDownloads > 10)) throw new Error('并发下载数必须在 1–10 之间');
    if (update.maxRetries !== undefined && (!Number.isInteger(update.maxRetries) || update.maxRetries < 0 || update.maxRetries > 10)) throw new Error('重试次数必须在 0–10 之间');
    if (update.virusScannerPath !== undefined && update.virusScannerPath !== null) {
      if (typeof update.virusScannerPath !== 'string' || update.virusScannerPath.trim().length > 4096) throw new Error('扫描器路径无效');
      const scanner = await stat(update.virusScannerPath);
      if (!scanner.isFile()) throw new Error('扫描器路径必须指向一个普通文件');
    }
    if (update.virusScannerArguments !== undefined && (!Array.isArray(update.virusScannerArguments) || update.virusScannerArguments.length > 32 ||
      update.virusScannerArguments.some(argument => typeof argument !== 'string' || argument.length > 1024 || argument.includes('\0'))))
      throw new Error('扫描参数最多 32 项，每项不超过 1024 个字符');
    if (update.speedLimitBytesSec !== undefined && (!Number.isFinite(update.speedLimitBytesSec) || update.speedLimitBytesSec < 0)) throw new Error('限速不能小于 0');
    if (proxyPassword != null && (typeof proxyPassword !== 'string' || proxyPassword.length > 1024)) throw new Error('代理密码长度无效');
    if (update.proxyUsername != null && (typeof update.proxyUsername !== 'string' || update.proxyUsername.length > 1024)) throw new Error('代理用户名长度无效');
    if (update.proxyMode !== undefined && !['disabled', 'custom', 'system'].includes(update.proxyMode)) throw new Error('代理模式无效');
    const changesProxy = update.proxyMode !== undefined || update.proxyUrl !== undefined || update.proxyUsername !== undefined || proxyPassword !== undefined;
    let proxy = await loadProxyCredentials();
    if (changesProxy) {
      const customProxySelected = update.proxyMode === 'custom' || (update.proxyMode === undefined && update.proxyUrl !== undefined);
      if (customProxySelected) {
        if (typeof update.proxyUrl !== 'string' || update.proxyUrl.length > 2048) throw new Error('请填写有效的代理地址');
        let proxyUrl: URL;
        try { proxyUrl = new URL(update.proxyUrl); } catch { throw new Error('代理地址格式无效'); }
        if (!['http:', 'https:', 'socks5:'].includes(proxyUrl.protocol) || !proxyUrl.hostname || proxyUrl.username || proxyUrl.password || proxyUrl.search || proxyUrl.hash || proxyUrl.pathname !== '/' && proxyUrl.pathname !== '') throw new Error('代理地址仅支持不含路径、查询、凭据的 HTTP、HTTPS 或 SOCKS5 地址');
      }
      if (update.proxyMode === 'disabled') proxy = { username: null, password: null };
      else if (update.proxyUsername !== undefined || proxyPassword !== undefined) {
        const username = typeof update.proxyUsername === 'string' ? update.proxyUsername.trim() : '';
        if (!username) proxy = { username: null, password: null };
        else {
          const password = typeof proxyPassword === 'string' && proxyPassword.length ? proxyPassword : (proxy.username === username ? proxy.password : null);
          if (!password) throw new Error('代理用户名已填写，请输入代理密码');
          proxy = { username, password };
        }
      }
      if (update.proxyMode === 'custom' && update.proxyUrl == null) throw new Error('自定义代理需要代理地址');
      await saveProxyCredentials(proxy);
      update.proxyUsername = null;
      await worker('tasks:set-proxy-credentials', proxy);
    }
    const updatedSettings = await worker<DownloadSettings>('tasks:update-download-settings', update);
    onClipboardMonitorChanged(updatedSettings.clipboardMonitorEnabled);
    if (process.platform === 'win32' && typeof update.launchAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: updatedSettings.launchAtLogin });
    return { ...updatedSettings, ...(changesProxy ? { proxyUsername: proxy.username } : {}) };
  });
  register('downloads:create-queue', async ({ name }) => {
    const settings = await worker<DownloadSettings>('tasks:download-settings');
    const normalized = name.trim().slice(0, 80);
    if (!normalized) throw new Error('队列名称不能为空');
    if (settings.queues.some(queue => queue.name === normalized)) throw new Error('此队列名称已存在');
    if (settings.queues.length >= 16) throw new Error('最多只能创建 16 个队列');
    return worker<DownloadSettings>('tasks:update-download-settings', { queues: [...settings.queues, { name: normalized, paused: false }] });
  });
  register('downloads:set-queue-paused', async ({ name, paused }) => {
    const settings = await worker<DownloadSettings>('tasks:download-settings');
    if (!settings.queues.some(queue => queue.name === name)) throw new Error('队列不存在');
    return worker<DownloadSettings>('tasks:update-download-settings', { queues: settings.queues.map(queue => queue.name === name ? { ...queue, paused } : queue) });
  });
  register('downloads:delete-queue', async ({ name }) => {
    if (name === '默认') throw new Error('默认队列不能删除');
    const settings = await worker<DownloadSettings>('tasks:download-settings');
    return worker<DownloadSettings>('tasks:update-download-settings', { queues: settings.queues.filter(queue => queue.name !== name) });
  });
  register('downloads:read-link-list', async ({ filePath }) => {
    if (!approvedFiles.delete(filePath)) throw new Error('请先通过系统文件选择器选择链接列表');
    if (!['.txt', '.lst', '.urls'].includes(extname(filePath).toLowerCase())) throw new Error('链接列表只支持 TXT、LST 或 URLS 文件');
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > 5 * 1024 * 1024) throw new Error('链接列表超过 5 MiB 或不是普通文件');
    const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 500) throw new Error('链接列表最多包含 500 条链接');
    return lines.filter(line => {
      try { return ['http:', 'https:', 'ftp:', 'ftps:', 'magnet:'].includes(new URL(line).protocol); } catch { return false; }
    });
  });
  register('downloads:import-torrent', async ({ torrentPath, directory, fileName, selectedFileIndices }) => {
    assertApprovedDirectory(directory);
    // A torrent downloaded by this app is trusted for the same existing import
    // flow; arbitrary local paths still require the system file picker.
    if (!approvedFiles.delete(torrentPath) && !isCompletedDownloadedTorrent(torrentPath)) throw new Error('请先通过系统文件选择器选择种子文件');
    const selected = await stat(torrentPath);
    if (!selected.isFile() || selected.size > 16 * 1024 * 1024) throw new Error('种子文件不是普通文件或超过 16 MiB');
    return worker<MagnetTask>('tasks:import-torrent', {
      torrentPath,
      ...(directory === undefined ? {} : { directory }),
      ...(fileName === undefined ? {} : { fileName }),
      ...(selectedFileIndices === undefined ? {} : { selectedFileIndices }),
    });
  });
  register('downloads:copy-link', async ({ id }) => {
    const task = snapshot().downloads.find(value => value.id === id);
    if (!task) throw new Error('下载任务不存在');
    clipboard.writeText(task.url);
    onClipboardWritten(task.url);
  });
  register('downloads:open-task', async ({ id, target }) => {
    const task = snapshot().downloads.find(value => value.id === id);
    if (!task) throw new Error('下载任务不存在');
    const path = target === 'folder' ? task.directory : join(task.directory, task.fileName);
    if (!existsSync(path)) throw new Error('文件尚未下载完成或目标路径不存在');
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  register('downloads:completion-action', async ({ action }) => {
    if (action === 'none') return;
    if (action === 'open_file' || action === 'open_folder') {
      const task = snapshot().downloads.find(value => value.status === 'completed');
      if (!task) return;
      const path = action === 'open_folder' ? task.directory : join(task.directory, task.fileName);
      if (!existsSync(path)) throw new Error('完成文件不存在');
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
      return;
    }
    if (action === 'exit' || action === 'shutdown') {
      const current = engine.currentSnapshot();
      const all = [...current.downloads.map(task => task.status), ...current.magnets.map(task => task.status)];
      if (!all.length || all.some(status => status !== 'completed')) throw new Error('仍有下载任务未成功完成，不能执行此动作');
      if (action === 'exit') { app.quit(); return; }
      if (process.platform !== 'win32') throw new Error('系统关机动作目前只支持 Windows');
      await runFile('shutdown.exe', ['/s', '/t', '0'], { windowsHide: true });
      return;
    }
    throw new Error('未知的完成后操作');
  });

  register('system:take-torrent-prompts', () => {
    const paths = pendingTorrentPrompts.splice(0);
    for (const path of paths) pendingTorrentPromptKeys.delete(process.platform === 'win32' ? path.toLowerCase() : path);
    return paths;
  });

  register('magnets:list', async () => (await worker<TaskSnapshot>('tasks:list')).magnets);
  register('magnets:inspect', async ({ url, torrentPath }) => {
    if (torrentPath && !approvedFiles.has(torrentPath) && !isCompletedDownloadedTorrent(torrentPath)) throw new Error('请先通过系统文件选择器选择种子文件');
    return worker<MagnetFilePreview>('magnets:inspect', { url, torrentPath });
  });
  register('magnets:inspect-task', ({ id }) => worker<MagnetFilePreview>('magnets:inspect-task', { id }));
  register('magnets:add', input => { assertApprovedDirectory(input.directory); return worker<MagnetTask>('magnets:add', input); });
  register('magnets:update-selection', ({ id, selectedFileIndices }) => worker<void>('magnets:update-selection', { id, selectedFileIndices }));
  register('magnets:pause', ({ id }) => worker<void>('magnets:pause', { id }));
  register('magnets:resume', ({ id }) => worker<void>('magnets:resume', { id }));
  register('magnets:remove', ({ id, deleteFiles }) => worker<void>('magnets:remove', { id, deleteFiles }));
  register('magnets:open-folder', async ({ id }) => {
    const task = (await worker<MagnetTask[]>('magnets:list')).find(candidate => candidate.id === id);
    if (!task) throw new Error('磁力任务不存在');
    const path = task.status === 'completed'
      ? join(task.directory, task.fileName)
      : join(task.directory, `.ldownload-${task.id}-partial`);
    if (!existsSync(path)) throw new Error('迅雷任务文件夹尚未生成');
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  register('magnets:settings', async () => {
    const settings = await worker<MagnetSettings>('tasks:magnet-settings');
    if (settings.defaultDownloadDirectory) approvedDirectories.add(normalizedDirectory(settings.defaultDownloadDirectory));
    return settings;
  });
  register('magnets:update-settings', async settings => {
    if (settings.defaultDownloadDirectory != null) assertApprovedDirectory(settings.defaultDownloadDirectory);
    if (settings.magnetRetryDelaySeconds !== undefined && (!Number.isInteger(settings.magnetRetryDelaySeconds) || settings.magnetRetryDelaySeconds < 1 || settings.magnetRetryDelaySeconds > 300)) throw new Error('磁力重试间隔必须在 1–300 秒之间');
    if (settings.virusScannerPath !== undefined && settings.virusScannerPath !== null) {
      if (typeof settings.virusScannerPath !== 'string' || settings.virusScannerPath.trim().length > 4096) throw new Error('扫描器路径无效');
      const scanner = await stat(settings.virusScannerPath);
      if (!scanner.isFile()) throw new Error('扫描器路径必须指向一个普通文件');
    }
    if (settings.virusScannerArguments !== undefined && (!Array.isArray(settings.virusScannerArguments) || settings.virusScannerArguments.length > 32 ||
      settings.virusScannerArguments.some(argument => typeof argument !== 'string' || argument.length > 1024 || argument.includes('\0'))))
      throw new Error('扫描参数最多 32 项，每项不超过 1024 个字符');
    return worker<MagnetSettings>('tasks:update-magnet-settings', settings);
  });

  register('site-collections:list', async () => {
    await ensureCollectionsLoaded();
    return sortedProjects();
  });
  register('site-collections:create', async input => {
    await ensureCollectionsLoaded();
    const url = assertWebUrl(input.startUrl);
    if (!Number.isInteger(input.maxDepth) || input.maxDepth < 0 || input.maxDepth > 4 ||
        !Number.isInteger(input.pageLimit) || input.pageLimit < 1 || input.pageLimit > 200) throw new Error('请检查链接深度和页面数量');
    const readPatterns = (items: unknown): string[] => {
      if (!Array.isArray(items) || items.length > 100 || items.some(item => typeof item !== 'string' || item.length > 512))
        throw new Error('采集规则格式无效');
      return items.map(item => String(item).trim()).filter(Boolean).slice(0, 50);
    };
    const now = Date.now();
    const project: SiteCollectionProject = {
      id: randomUUID(), startUrl: url.href, maxDepth: input.maxDepth, pageLimit: input.pageLimit,
      includePatterns: readPatterns(input.includePatterns), excludePatterns: readPatterns(input.excludePatterns),
      fileExtensions: readPatterns(input.fileExtensions).map(value => value.replace(/^\./, '').toLowerCase()),
      frontier: [{ url: url.href, depth: 0 }], visitedPages: [], foundLinks: [],
      status: 'idle', error: null, createdAt: now, updatedAt: now,
    };
    updateCollection(project);
    return project;
  });
  register('site-collections:run', async ({ id }) => {
    await ensureCollectionsLoaded();
    const project = projects.get(id);
    if (!project) throw new Error('收集项目不存在');
    if (collectionControllers.has(id)) return sortedProjects();
    if (collectionControllers.size) throw new Error('已有一个站点采集任务正在运行');
    const controller = new AbortController();
    collectionControllers.set(id, controller);
    project.status = 'running'; project.error = null; updateCollection(project);
    void runSiteCollection(project, controller.signal, updateCollection).then(result => {
      updateCollection(result);
    }).catch(error => {
      const current = projects.get(id);
      if (!current) return;
      current.status = controller.signal.aborted ? 'stopped' : 'failed';
      current.error = controller.signal.aborted ? null : (error instanceof Error ? error.message : String(error));
      updateCollection(current);
    }).finally(() => {
      if (collectionControllers.get(id) === controller) collectionControllers.delete(id);
    });
    return sortedProjects();
  });
  register('site-collections:stop', async ({ id }) => {
    await ensureCollectionsLoaded();
    const project = projects.get(id);
    if (!project) throw new Error('收集项目不存在');
    collectionControllers.get(id)?.abort(new Error('采集已停止'));
    project.status = 'stopped'; project.error = null;
    updateCollection(project);
    return sortedProjects();
  });
  register('site-collections:delete', async ({ id }) => {
    await ensureCollectionsLoaded();
    if (collectionControllers.has(id)) throw new Error('请先暂停正在运行的采集项目');
    projects.delete(id); collectionRevision++;
    publishCollections(collectionSnapshot());
    await persistCollections();
    return sortedProjects();
  });
  register('site-collections:add-links', async ({ id, links, queueName }) => {
    await ensureCollectionsLoaded();
    const project = projects.get(id);
    if (!project) throw new Error('收集项目不存在');
    if (!Array.isArray(links) || links.length > 100 || links.some(url => typeof url !== 'string' || url.length > 16_384))
      throw new Error('每次最多选择 100 个有效链接');
    const available = new Set(project.foundLinks);
    let added = 0;
    for (const url of links) {
      if (!available.has(url)) continue;
      try { await worker<DownloadTask>('tasks:add', { url, queueName }); added++; } catch { /* count rejected links */ }
    }
    return { added, failed: links.length - added };
  });

  register('browser:open-extension-folder', async ({ browser }) => {
    if (process.platform !== 'win32') throw new Error('浏览器扩展目录集成目前仅支持 Windows');
    if (!['chrome', 'edge', 'firefox'].includes(browser)) throw new Error('不支持此浏览器');
    const folder = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'browser-extension' : 'vendor/browser-extension', browser === 'firefox' ? 'firefox' : 'chromium');
    if (!existsSync(folder)) throw new Error('浏览器扩展文件夹不存在：' + folder);
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  });
  register('browser:install-native-host', async ({ browser, extensionId }) => {
    if (process.platform !== 'win32') throw new Error('浏览器原生消息主机目前仅支持 Windows');
    if (!['chrome', 'edge', 'firefox'].includes(browser)) throw new Error('不支持此浏览器');
    const extension = extensionId.trim();
    if (browser === 'firefox' && extension !== 'ldownload@open-source.local') throw new Error('Firefox 扩展使用固定 ID：ldownload@open-source.local');
    if (browser !== 'firefox' && !/^[a-p]{32}$/.test(extension)) throw new Error('Chrome 和 Edge 扩展 ID 必须是 32 位 a–p 字符');
    const manifestDirectory = join(app.getPath('userData'), 'browser-native-host');
    const manifestPath = join(manifestDirectory, 'org.ldownload1.browser.json');
    const hostExecutable = app.isPackaged
      ? join(process.resourcesPath, 'browser-native-host', 'LDownloadNativeHost.exe')
      : join(app.getAppPath(), 'out', 'browser-native-host', 'LDownloadNativeHost.exe');
    if (!existsSync(hostExecutable)) throw new Error('浏览器原生消息宿主不存在，请重新构建或安装 LDownload。');
    const manifest = {
      name: 'org.ldownload1.browser',
      description: 'LDownload browser link handoff',
      path: hostExecutable,
      type: 'stdio',
      ...(browser === 'firefox'
        ? { allowed_extensions: ['ldownload@open-source.local'] }
        : { allowed_origins: ['chrome-extension://' + extension + '/'] }),
    };
    await mkdir(manifestDirectory, { recursive: true });
    const temporary = manifestPath + '.tmp';
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, manifestPath);
    const key = browser === 'chrome'
      ? 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\org.ldownload1.browser'
      : browser === 'edge'
        ? 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\org.ldownload1.browser'
        : 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\org.ldownload1.browser';
    await runFile(resolveRegistryExecutable(), ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
    return true;
  });
  register('system:read-clipboard', async () => (await clipboard.readText()).slice(0, 32_768));
  register('system:register-protocols', () => {
    const executable = app.isPackaged ? undefined : process.execPath;
    const args = app.isPackaged ? undefined : [app.getAppPath()];
    const ldownload = app.setAsDefaultProtocolClient('ldownload', executable, args);
    const magnet = app.setAsDefaultProtocolClient('magnet', executable, args);
    return ldownload && magnet;
  });
  register('system:default-directory', async () => {
    const settings = await worker<DownloadSettings>('tasks:download-settings');
    const directory = settings.defaultDownloadDirectory || app.getPath('downloads');
    approvedDirectories.add(normalizedDirectory(directory));
    return directory;
  });
  register('system:choose-file', async request => {
    const filters = request.kind === 'torrent'
      ? [{ name: 'BitTorrent', extensions: ['torrent'] }]
      : request.kind === 'import'
        ? [{ name: '下载链接或种子', extensions: ['txt', 'lst', 'urls', 'torrent'] }, { name: 'BitTorrent', extensions: ['torrent'] }]
        : [{ name: '下载链接列表', extensions: ['txt', 'lst', 'urls'] }];
    const options = {
      title: request.kind === 'torrent' ? '选择种子文件' : request.kind === 'import' ? '导入链接列表或种子' : '选择链接列表',
      properties: ['openFile'] as Array<'openFile'>,
      filters,
    };
    const mainWindow = getCurrentWindow();
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    approvedFiles.add(file);
    return file;
  });
  register('system:choose-directory', async request => {
    const options = {
      title: '选择下载文件夹',
      ...(request.defaultPath === undefined ? {} : { defaultPath: request.defaultPath }),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const mainWindow = getCurrentWindow();
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    const selected = result.canceled ? null : result.filePaths[0] || null;
    if (selected) approvedDirectories.add(normalizedDirectory(selected));
    return selected;
  });
  register('system:copy-text', ({ text }) => {
    const value = text.slice(0, 16_384);
    clipboard.writeText(value);
    onClipboardWritten(value);
  });
  register('system:capabilities', async (): Promise<EngineCapabilities[]> => {
    const configuredSdkDirectory = app.isPackaged
      ? join(process.resourcesPath, 'thunder', 'sdk')
      : join(app.getAppPath(), 'vendor', 'thunder', 'sdk');
    const sdkDirectory = process.platform === 'win32' ? await findVerifiedSdkDirectory(configuredSdkDirectory) : null;
    const bridgePath = app.isPackaged
      ? join(process.resourcesPath, 'thunder', 'ThunderBridge.exe')
      : join(app.getAppPath(), 'out', 'thunder', 'ThunderBridge.exe');
    const bridgeAvailable = process.platform === 'win32' && existsSync(bridgePath);
    return [
      { id: 'http', displayName: 'HTTP/HTTPS 分段下载引擎', protocols: ['http', 'https'], platforms: ['win32', 'darwin', 'linux'], available: true, reason: '运行于隔离的 utility process' },
      { id: 'ftp', displayName: 'FTP/FTPS 下载引擎', protocols: ['ftp', 'ftps'], platforms: ['win32', 'darwin', 'linux'], available: true, reason: '运行于隔离的 utility process；FTPS 使用隐式 TLS' },
      { id: 'thunder-sdk', displayName: '迅雷 SDK 引擎', protocols: ['magnet', 'torrent'], platforms: ['win32'], available: Boolean(sdkDirectory && bridgeAvailable), reason: !sdkDirectory ? `未找到校验通过的随包迅雷 SDK：${configuredSdkDirectory}` : !bridgeAvailable ? '迅雷桥接程序未构建' : `使用已校验的迅雷 2.86.202.143（${sdkDirectory}）` },
    ];
  });
}
