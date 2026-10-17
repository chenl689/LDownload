import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { nextScheduledAtSeconds, scheduledAtMilliseconds } from '../core/scheduling';
import { normalizeDownloadSegmentCount, regroupDownloadSegments } from '../../src/shared/contracts';
import type {
  AddDownloadInput,
  DownloadSettings,
  DownloadTask,
  MagnetFilePreview,
  MagnetSettings,
  MagnetTask,
  TaskSnapshot,
} from '../../src/shared/contracts';
import { ThunderSdkEngine, parseMagnetIdentity, type ThunderTaskProgress } from '../engines/thunder/thunder-sdk';
import { downloadTaskWithEngine, inspectDownloadUrl } from '../core/download-engine';
import { createThrottledPublisher } from '../core/throttled-publisher';
import { ProgressSpeedEstimator } from '../core/progress-speed-estimator';
import { sanitizeDownloadFileName } from '../engines/http/http-engine';
import { downloadSourceIdentity, findDuplicateDownloadSource } from '../../src/shared/download-identity';

type WorkerMethod =
  | 'tasks:list' | 'tasks:inspect-url' | 'tasks:add' | 'tasks:pause' | 'tasks:resume' | 'tasks:resume-order' | 'tasks:start-all' | 'tasks:pause-all'
  | 'tasks:export-input-secrets' | 'tasks:restore-input-secrets' | 'tasks:export-proxy-secrets' | 'tasks:set-proxy-credentials'
  | 'tasks:remove' | 'tasks:set-category' | 'tasks:set-queue' | 'tasks:import-torrent'
  | 'tasks:download-settings' | 'tasks:update-download-settings'
  | 'tasks:magnet-settings' | 'tasks:update-magnet-settings'
  | 'magnets:list' | 'magnets:inspect' | 'magnets:inspect-task' | 'magnets:add' | 'magnets:update-selection'
  | 'magnets:pause' | 'magnets:resume' | 'magnets:remove';

interface WorkerRequest { id: number; method: WorkerMethod; payload?: unknown }
interface WorkerReply { id: number; ok: boolean; value?: unknown; error?: string }
interface WorkerPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: WorkerRequest }) => void): void;
  start(): void;
}
interface PersistedState {
  revision: number;
  downloads: DownloadTask[];
  downloadInputs: Record<string, AddDownloadInput>;
  magnets: MagnetTask[];
  schedulerOrder: string[];
  downloadSettings: DownloadSettings;
  magnetSettings: MagnetSettings;
}

const stateFile = process.env.LDOWNLOAD_STATE_FILE;
const stateDirectory = stateFile ? dirname(stateFile) : join(process.cwd(), '.ldownload-engine');
const parentPort = (process as NodeJS.Process & {
  parentPort?: { once(event: 'message', listener: (event: { ports: WorkerPort[] }) => void): void };
}).parentPort;
const thunder = new ThunderSdkEngine({
  bundledSdkDirectory: process.env.LDOWNLOAD_THUNDER_BUNDLED_SDK_DIR || '',
  stateDirectory,
  bridgeExecutable: process.env.LDOWNLOAD_THUNDER_BRIDGE_PATH || '',
});

const defaultDownloadSettings = (): DownloadSettings => ({
  maxConcurrentDownloads: 3,
  segmentsPerDownload: 8,
  autoSegmentDownloads: true,
  connectTimeoutSeconds: 30,
  maxRetries: 3,
  speedLimitBytesSec: 0,
  defaultDownloadDirectory: process.env.LDOWNLOAD_DEFAULT_DIRECTORY || join(homedir(), 'Downloads'),
  proxyMode: 'disabled',
  proxyUrl: null,
  proxyUsername: null,
  allowInsecureProxyAuth: false,
  visibleColumns: ['progress', 'size', 'speed', 'status'],
  completionAction: 'none',
  clipboardMonitorEnabled: false,
  virusScannerPath: null,
  virusScannerArguments: [],
  language: 'zh-CN',
  toolbarButtons: ['theme', 'notifications', 'import', 'new-download'],
  minimizeToTray: false,
  launchAtLogin: false,
  queues: [{ name: '默认', paused: false }],
});

const defaultMagnetSettings = (): MagnetSettings => ({
  magnetRetryDelaySeconds: 10,
  torrentUpnpEnabled: false,
  torrentPublicTrackersEnabled: false,
  torrentEngine: 'thunder',
  bundledSdkDirectory: process.env.LDOWNLOAD_THUNDER_BUNDLED_SDK_DIR || null,
  defaultDownloadDirectory: null,
  virusScannerPath: null,
  virusScannerArguments: [],
});

let proxyCredentials: { username: string | null; password: string | null } = { username: null, password: null };
let legacyProxyUsername: string | null = null;
let removedLegacySettings = false;

let state: PersistedState = {
  revision: 0,
  downloads: [],
  downloadInputs: {},
  magnets: [],
  schedulerOrder: [],
  downloadSettings: defaultDownloadSettings(),
  magnetSettings: defaultMagnetSettings(),
};
let port: WorkerPort;
let persistChain = Promise.resolve();
let progressPersistenceTimer: ReturnType<typeof setTimeout> | null = null;
let currentInspection: AbortController | null = null;
const magnetControllers = new Map<string, AbortController>();
const magnetRuns = new Map<string, Promise<void>>();
const magnetSpeedEstimators = new Map<string, ProgressSpeedEstimator>();
const downloadControllers = new Map<string, AbortController>();
const downloadRuns = new Map<string, Promise<void>>();
const pendingDownloadSources = new Set<string>();
const pendingDownloadTargets = new Set<string>();
let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerSuspended = 0;

function schedulerTaskIds(): string[] {
  const tasks = [
    ...state.downloads.map(task => ({ id: task.id, createdAt: task.createdAt })),
    ...state.magnets.map(task => ({ id: 'magnet:' + task.id, createdAt: task.createdAt })),
  ];
  const available = new Set(tasks.map(task => task.id));
  const ordered = state.schedulerOrder.filter((id, index) => available.has(id) && state.schedulerOrder.indexOf(id) === index);
  const included = new Set(ordered);
  tasks.sort((left, right) => right.createdAt - left.createdAt);
  for (const task of tasks) if (!included.has(task.id)) ordered.push(task.id);
  state.schedulerOrder = ordered;
  return ordered;
}

function rememberTaskForScheduling(id: string): void {
  state.schedulerOrder = [id, ...state.schedulerOrder.filter(candidate => candidate !== id)];
}

function forgetTaskFromScheduling(id: string): void {
  state.schedulerOrder = state.schedulerOrder.filter(candidate => candidate !== id);
}

async function restoreState(): Promise<void> {
  if (stateFile) {
    try {
      const value = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<PersistedState>;
      legacyProxyUsername = typeof value.downloadSettings?.proxyUsername === 'string' ? value.downloadSettings.proxyUsername : null;
      const savedMagnetSettings = value.magnetSettings as (Partial<MagnetSettings> & { thunderInstallDirectory?: string | null; torrentMaxPeers?: number }) | undefined;
      const { thunderInstallDirectory: _legacyThunderPath, torrentMaxPeers: _legacyTorrentMaxPeers, ...restoredMagnetSettings } = savedMagnetSettings || {};
      const savedDownloadSettings = value.downloadSettings as (Partial<DownloadSettings> & { maxGlobalConnections?: number; categoryRules?: Array<Record<string, unknown>> }) | undefined;
      const { maxGlobalConnections: _legacyMaxGlobalConnections, categoryRules: _legacyCategoryRules, ...restoredDownloadSettings } = savedDownloadSettings || {};
      const savedSegmentCount = savedDownloadSettings?.segmentsPerDownload;
      const migratedSegmentCount = normalizeDownloadSegmentCount(
        savedSegmentCount ?? (savedDownloadSettings?.autoSegmentDownloads === false ? 1 : 8),
      );
      removedLegacySettings = Boolean(savedMagnetSettings && Object.prototype.hasOwnProperty.call(savedMagnetSettings, 'torrentMaxPeers')) || Boolean(savedDownloadSettings && (Object.prototype.hasOwnProperty.call(savedDownloadSettings, 'maxGlobalConnections') || Object.prototype.hasOwnProperty.call(savedDownloadSettings, 'categoryRules')));
      const bundledSdkDirectory = process.env.LDOWNLOAD_THUNDER_BUNDLED_SDK_DIR || null;
      state = {
        revision: Number.isSafeInteger(value.revision) ? Number(value.revision) : 0,
        downloads: Array.isArray(value.downloads) ? value.downloads.map(task => ({ ...task, speedLimitBytesSec: task.speedLimitBytesSec ?? null })) : [],
        downloadInputs: value.downloadInputs && typeof value.downloadInputs === 'object' ? value.downloadInputs : {},
        schedulerOrder: Array.isArray(value.schedulerOrder) ? value.schedulerOrder.filter((id): id is string => typeof id === 'string') : [],
        magnets: Array.isArray(value.magnets) ? value.magnets.map(task => {
          const { thunderInstallDirectory: _legacyTaskPath, ...restoredTask } = task as MagnetTask & { thunderInstallDirectory?: string | null };
          return { ...restoredTask, bundledSdkDirectory };
        }) : [],
        downloadSettings: { ...defaultDownloadSettings(), ...restoredDownloadSettings, segmentsPerDownload: migratedSegmentCount, proxyUsername: null },
        
        magnetSettings: { ...defaultMagnetSettings(), ...restoredMagnetSettings, torrentEngine: 'thunder', bundledSdkDirectory },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let changed = false;
  for (const task of state.downloads) {
    // Older versions persisted every dynamically-created lease in task.segments.
    // Project those legacy rows back to the user's selected logical segments so
    // a paused task does not keep showing (for example) 28 scheduler fragments.
    // Single-range tasks are left alone because they may have come from a server
    // without Range support or a deliberately selected single connection.
    if (task.segments.length > 1 && task.totalBytes !== null && task.totalBytes > 0) {
      const selected = task.totalBytes < 4 * 1024 * 1024
        ? 1
        : Math.min(state.downloadSettings.segmentsPerDownload, Math.floor(task.totalBytes / (1024 * 1024)));
      const regrouped = regroupDownloadSegments(task.segments, task.totalBytes, Math.max(1, selected));
      if (regrouped) {
        task.segments = regrouped;
        changed = true;
      }
    }
    if (task.status === 'downloading' || task.status === 'merging' || task.status === 'scanning') {
      task.status = 'paused'; task.speedBytesSec = 0; task.updatedAt = Date.now(); changed = true;
    }
  }
  for (const task of state.magnets) {
    if (task.status === 'downloading') {
      task.status = 'paused'; task.speedBytesSec = 0; task.livePeers = 0; task.phase = null; task.updatedAt = Date.now(); changed = true;
    }
  }
  if (changed) {
    state.revision++;
    // Persist the paused status and the migrated segment projection together;
    // otherwise each app restart would repeat the same legacy-state repair.
    persistState();
  }
}

function snapshot(): TaskSnapshot {
  return { revision: state.revision, downloads: state.downloads, magnets: state.magnets };
}

function publishSnapshot(): void {
  state.revision++;
  port.postMessage({ type: 'snapshot', snapshot: snapshot() });
}

function persistState(): void {
  if (!stateFile) return;
  const persistentInputs = Object.fromEntries(Object.entries(state.downloadInputs).map(([id, input]) => {
    const { headers: _headers, cookie: _cookie, referer: _referer, userAgent: _userAgent, authScheme: _authScheme, authUsername: _authUsername, authPassword: _authPassword, allowInsecureAuth: _allowInsecureAuth, taskId: _taskId, ...safeInput } = input;
    return [id, safeInput];
  }));
  const { proxyUsername: _proxyUsername, ...persistentSettings } = state.downloadSettings;
  const serialized = JSON.stringify({ ...state, downloadInputs: persistentInputs, downloadSettings: persistentSettings });
  const temporary = stateFile + '.tmp';
  persistChain = persistChain.then(async () => {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, stateFile);
  }).catch(error => {
    port.postMessage({ type: 'log', level: 'error', code: 'STATE_PERSIST_FAILED', message: 'Could not persist task state: ' + String(error) });
  });
}

const progressPublisher = createThrottledPublisher(publishSnapshot, 125);

function publishProgress(): void {
  progressPublisher.schedule();
  if (!stateFile || progressPersistenceTimer) return;
  progressPersistenceTimer = setTimeout(() => {
    progressPersistenceTimer = null;
    persistState();
  }, 1000);
}

function publish(): void {
  progressPublisher.cancel();
  publishSnapshot();
  if (progressPersistenceTimer) clearTimeout(progressPersistenceTimer);
  progressPersistenceTimer = null;
  persistState();
}
function getTask(id: string): DownloadTask {
  const task = state.downloads.find(candidate => candidate.id === id);
  if (!task) throw new Error('任务不存在或已删除');
  return task;
}

function getMagnet(id: string): MagnetTask {
  const task = state.magnets.find(candidate => candidate.id === id);
  if (!task) throw new Error('磁力任务不存在或已删除');
  return task;
}

function selectedBytes(task: MagnetTask, metadata: MagnetFilePreview): number {
  const indices = task.selectedFileIndices ?? metadata.files.map(file => file.index);
  if (!indices.length || new Set(indices).size !== indices.length) throw new Error('请选择至少一个不重复的种子文件');
  let total = 0;
  for (const index of indices) {
    const file = metadata.files[index];
    if (!file || file.index !== index) throw new Error('种子文件选择包含无效索引');
    total += file.size;
    if (!Number.isSafeInteger(total)) throw new Error('所选文件总大小超出支持范围');
  }
  return total;
}

function makePreview(metadata: MagnetFilePreview): MagnetFilePreview {
  return { ...metadata, files: metadata.files.map(file => ({ ...file })) };
}

async function inspectMagnet(url: string, torrentPath: string | null): Promise<MagnetFilePreview> {
  if (torrentPath) {
    const { metadata } = await thunder.inspectTorrentFile(torrentPath);
    return makePreview(metadata);
  }
  if (!url.trim()) throw new Error('请输入磁力链接或选择种子文件');
  currentInspection?.abort();
  const controller = new AbortController();
  currentInspection = controller;
  try { return makePreview(await thunder.inspectMagnet(url, controller.signal)); }
  finally { if (currentInspection === controller) currentInspection = null; }
}

function magnetDirectory(directory?: string | null): string {
  return directory?.trim() || state.magnetSettings.defaultDownloadDirectory ||
    join(state.downloadSettings.defaultDownloadDirectory || join(homedir(), 'Downloads'), 'Magnet');
}

function validateMagnetFileName(fileName: string): string {
  if (/[\\/:\0<>"|?*]/.test(fileName) || /[. ]$/.test(fileName) || fileName === '.' || fileName === '..' || fileName.length > 255 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) {
    throw new Error('保存名称包含无效字符');
  }
  return fileName;
}

function createMagnetTask(
  url: string,
  metadata: MagnetFilePreview,
  torrentFilePath: string,
  fileName?: string | null,
  directory?: string | null,
  selectedFileIndices?: number[] | null,
): MagnetTask {
  const task: MagnetTask = {
    id: randomUUID(), url, infoHash: metadata.infoHash, fileName: validateMagnetFileName(fileName?.trim() || metadata.name),
    directory: magnetDirectory(directory), torrentFilePath, selectedFileIndices: selectedFileIndices ?? null,
    downloadEngine: 'thunder', bundledSdkDirectory: state.magnetSettings.bundledSdkDirectory,
    status: 'queued', totalBytes: selectedBytes({ selectedFileIndices: selectedFileIndices ?? null } as MagnetTask, metadata),
    downloadedBytes: 0, speedBytesSec: 0, error: null, phase: 'waiting_engine', livePeers: 0, dhtNodes: 0,
    diagnostics: { discoveredPeers: 0, trackerSuccesses: 0, trackerFailures: 0, connectionAttempts: 0, peerRetries: 0, blockedPeers: 0, lastNetworkError: null },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  return task;
}

function startMagnetTask(id: string): void {
  if (magnetControllers.has(id)) return;
  const task = state.magnets.find(candidate => candidate.id === id);
  if (!task || task.status !== 'queued') return;
  const torrentFilePath = task.torrentFilePath;
  if (!torrentFilePath) {
    task.status = 'failed'; task.phase = null; task.error = '任务缺少已校验的种子元数据'; task.updatedAt = Date.now(); publish();
    return;
  }
  const controller = new AbortController();
  magnetControllers.set(id, controller);
  magnetSpeedEstimators.set(id, new ProgressSpeedEstimator());
  task.status = 'downloading'; task.phase = 'waiting_engine'; task.error = null; task.speedBytesSec = 0; task.updatedAt = Date.now();
  publish();
  const run = thunder.download({ ...task, torrentFilePath }, controller.signal, progress => updateMagnetProgress(id, progress), async files => {
    const settings = state.magnetSettings;
    if (!settings.virusScannerPath?.trim()) return;
    const current = state.magnets.find(candidate => candidate.id === id);
    if (current) { current.phase = 'scanning'; current.speedBytesSec = 0; current.updatedAt = Date.now(); publish(); }
    for (const file of files) await runVirusScanner(settings.virusScannerPath, settings.virusScannerArguments, file, controller.signal);
  }).then(result => {
    const current = state.magnets.find(candidate => candidate.id === id);
    if (!current) return;
    current.status = 'completed'; current.totalBytes = result.selectedBytes;
    current.downloadedBytes = result.selectedBytes; current.speedBytesSec = 0; current.phase = 'completed';
    current.error = null; current.updatedAt = Date.now(); publish();
  }).catch(error => {
    const current = state.magnets.find(candidate => candidate.id === id);
    if (!current) return;
    current.speedBytesSec = 0;
    current.status = controller.signal.aborted ? 'paused' : 'failed';
    current.phase = null;
    current.error = controller.signal.aborted ? null : (error instanceof Error ? error.message : String(error));
    current.updatedAt = Date.now(); publish();
  }).finally(() => {
    if (magnetControllers.get(id) === controller) magnetControllers.delete(id);
    magnetRuns.delete(id);
    magnetSpeedEstimators.delete(id);
    startQueuedTasks();
  });
  magnetRuns.set(id, run);
  void run;
}

function updateMagnetProgress(id: string, progress: ThunderTaskProgress): void {
  const task = state.magnets.find(candidate => candidate.id === id);
  if (!task) return;
  task.status = 'downloading'; task.phase = progress.phase;
  task.totalBytes = progress.totalBytes || task.totalBytes;
  task.downloadedBytes = Math.max(task.downloadedBytes, progress.downloadedBytes);
  const estimator = magnetSpeedEstimators.get(id);
  task.speedBytesSec = estimator?.update(task.downloadedBytes, Date.now()) ?? 0;
  task.updatedAt = Date.now();
  publishProgress();
}

function httpSettings() {
  return {
    connectTimeoutSeconds: state.downloadSettings.connectTimeoutSeconds,
    maxRetries: state.downloadSettings.maxRetries,
    speedLimitBytesSec: state.downloadSettings.speedLimitBytesSec,
    segmentsPerDownload: state.downloadSettings.segmentsPerDownload,
    autoSegmentDownloads: state.downloadSettings.autoSegmentDownloads,
    virusScannerPath: state.downloadSettings.virusScannerPath,
    virusScannerArguments: state.downloadSettings.virusScannerArguments,
    proxyMode: state.downloadSettings.proxyMode,
    proxyUrl: state.downloadSettings.proxyUrl,
    proxyUsername: proxyCredentials.username,
    proxyPassword: proxyCredentials.password,
    allowInsecureProxyAuth: state.downloadSettings.allowInsecureProxyAuth,
  };
}

async function inspectDownload(input: AddDownloadInput) {
  return inspectDownloadUrl(input, state.downloadSettings.connectTimeoutSeconds, httpSettings());
}


async function runVirusScanner(executablePath: string | null, scannerArguments: string[], path: string, signal: AbortSignal): Promise<void> {
  const executable = executablePath?.trim();
  if (!executable) return;
  if (signal.aborted) throw signal.reason || new Error('病毒扫描已取消');
  let filePlaceholder = false;
  const args = (scannerArguments || []).map(argument => {
    if (argument.includes('{file}')) filePlaceholder = true;
    return argument.replaceAll('{file}', path);
  });
  if (!filePlaceholder) args.push(path);
  await new Promise<void>((resolveScan, rejectScan) => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
    let settled = false, timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) rejectScan(error); else resolveScan();
    };
    const abort = () => { child.kill(); finish(new Error('病毒扫描已取消；临时文件保留')); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15 * 60 * 1000);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(new Error('无法启动配置的病毒扫描器：' + error.message)));
    child.once('close', code => {
      if (signal.aborted) finish(new Error('病毒扫描已取消；临时文件保留'));
      else if (timedOut) finish(new Error('病毒扫描超过 15 分钟；文件未最终保存'));
      else if (code === 0) finish();
      else finish(new Error('配置的病毒扫描器返回非零退出码：' + String(code)));
    });
    if (signal.aborted) abort();
  });
}

function nextRepeatFileName(baseName: string, timestamp: number): string {
  const safeBase = sanitizeDownloadFileName(baseName);
  const dot = safeBase.lastIndexOf('.');
  const split = dot > 0 ? dot : safeBase.length;
  const stamp = new Date(timestamp).toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return sanitizeDownloadFileName(safeBase.slice(0, split) + ' (' + stamp + ')' + safeBase.slice(split));
}

function scheduleNextRepeat(task: DownloadTask): void {
  const interval = task.repeatIntervalSeconds;
  if (interval !== 86_400 && interval !== 604_800) return;
  const input = state.downloadInputs[task.id] || { url: task.url };
  const baseName = task.repeatFileName || (typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.trim() : task.fileName);
  const scheduledAt = nextScheduledAtSeconds(Date.now(), interval);
  const nextFileName = nextRepeatFileName(baseName, scheduledAt * 1000);
  task.repeatFileName = baseName;
  task.fileName = nextFileName;
  task.status = 'queued';
  task.totalBytes = null;
  task.downloadedBytes = 0;
  task.segments = [];
  task.speedBytesSec = 0;
  task.error = null;
  task.contentType = null;
  task.scheduledAt = scheduledAt;
  task.etag = null;
  task.lastModified = null;
  task.createdAt = Date.now();
  task.updatedAt = task.createdAt;
  rememberTaskForScheduling(task.id);
  state.downloadInputs[task.id] = { ...input, fileName: nextFileName, scheduledAt };
  publish();
}

function startDownloadTask(id: string): void {
  if (downloadControllers.has(id)) return;
  const task = state.downloads.find(candidate => candidate.id === id);
  if (!task || task.status !== 'queued') return;
  const queue = state.downloadSettings.queues.find(item => item.name === task.queueName);
  if (queue?.paused) return;
  if (scheduledAtMilliseconds(task.scheduledAt) > Date.now()) return;
  const input = state.downloadInputs[id] || { url: task.url };
  const controller = new AbortController();
  downloadControllers.set(id, controller);
  task.status = 'downloading'; task.error = null; task.speedBytesSec = 0; task.updatedAt = Date.now();
  publish();
  const samples: Array<{ time: number; bytes: number }> = [];
  const run = downloadTaskWithEngine({ ...task, ...input, id, url: task.url, fileName: task.fileName, directory: task.directory },
    httpSettings(), controller.signal, progress => {
      const current = state.downloads.find(candidate => candidate.id === id);
      if (!current) return;
      const now = Date.now();
      current.status = 'downloading'; current.totalBytes = progress.totalBytes;
      current.downloadedBytes = progress.downloadedBytes; current.segments = progress.segments;
      current.etag = progress.etag; current.lastModified = progress.lastModified; current.updatedAt = now;
      samples.push({ time: now, bytes: progress.downloadedBytes });
      while (samples.length > 1 && samples[0] && now - samples[0].time > 3000) samples.shift();
      const first = samples[0];
      current.speedBytesSec = first && now > first.time ? Math.max(0, (progress.downloadedBytes - first.bytes) * 1000 / (now - first.time)) : 0;
      publishProgress();
    }, false, async partialPath => {
      if (!state.downloadSettings.virusScannerPath?.trim()) return;
      const current = state.downloads.find(candidate => candidate.id === id);
      if (current) { current.status = 'scanning'; current.speedBytesSec = 0; current.updatedAt = Date.now(); publish(); }
      await runVirusScanner(state.downloadSettings.virusScannerPath, state.downloadSettings.virusScannerArguments, partialPath, controller.signal);
    }).then(result => {
      const current = state.downloads.find(candidate => candidate.id === id);
      if (!current) return;
      current.fileName = result.fileName; current.status = 'completed';
      current.totalBytes = result.metadata.totalBytes;
      current.downloadedBytes = result.metadata.totalBytes ?? current.downloadedBytes;
      current.segments = current.segments.map(segment => ({ ...segment, active: false }));
      current.etag = result.metadata.etag; current.lastModified = result.metadata.lastModified;
      current.speedBytesSec = 0; current.error = null; current.updatedAt = Date.now(); publish();
      scheduleNextRepeat(current);
    }).catch(error => {
      const current = state.downloads.find(candidate => candidate.id === id);
      if (!current) return;
      current.status = controller.signal.aborted ? 'paused' : 'failed';
      current.speedBytesSec = 0;
      current.segments = current.segments.map(segment => ({ ...segment, active: false }));
      current.error = controller.signal.aborted ? null : (error instanceof Error ? error.message : String(error));
      current.updatedAt = Date.now(); publish();
    }).finally(() => {
      if (downloadControllers.get(id) === controller) downloadControllers.delete(id);
      downloadRuns.delete(id);
      startQueuedTasks();
    });
  downloadRuns.set(id, run);
}

function startQueuedTasks(): void {
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
  if (schedulerSuspended > 0) return;
  const settings = state.downloadSettings;
  const max = Math.max(1, Math.min(10, settings.maxConcurrentDownloads));
  for (const id of schedulerTaskIds()) {
    if (downloadControllers.size + magnetControllers.size >= max) break;
    if (id.startsWith('magnet:')) {
      const task = state.magnets.find(candidate => candidate.id === id.slice('magnet:'.length));
      if (task?.status === 'queued' && !magnetControllers.has(task.id)) startMagnetTask(task.id);
      continue;
    }
    const task = state.downloads.find(candidate => candidate.id === id);
    if (!task || task.status !== 'queued' || downloadControllers.has(task.id)) continue;
    const queue = settings.queues.find(item => item.name === task.queueName);
    if (queue?.paused || scheduledAtMilliseconds(task.scheduledAt) > Date.now()) continue;
    startDownloadTask(task.id);
  }
  const next = state.downloads.filter(task => task.status === 'queued' && scheduledAtMilliseconds(task.scheduledAt) > Date.now())
    .reduce((value, task) => Math.min(value, scheduledAtMilliseconds(task.scheduledAt)), Number.POSITIVE_INFINITY);
  if (Number.isFinite(next)) scheduleTimer = setTimeout(startQueuedTasks, Math.max(0, Math.min(2_147_000_000, next - Date.now())));
}

async function removeDownloadFiles(task: DownloadTask): Promise<void> {
  const output = join(resolve(task.directory), sanitizeDownloadFileName(task.fileName));
  for (const candidate of [output, output + '.part', output + '.ldl']) {
    const info = await lstat(candidate).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('拒绝删除非普通下载文件');
    await rm(candidate);
  }
}

function ensureMagnetIsUnique(infoHash: string): void {
  const existing = state.magnets.find(task => task.infoHash.toLowerCase() === infoHash.toLowerCase());
  if (existing) throw new Error('该种子已在任务列表中：' + existing.fileName);
}

function downloadTargetKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute;
}

type TargetNameKind = 'download' | 'magnet';

function targetResources(directory: string, fileName: string, kind: TargetNameKind): string[] {
  const output = resolve(directory, fileName);
  // A regular download also owns its resumable files; treating those paths as
  // reserved prevents a second task from colliding with a .part/.ldl workspace.
  return kind === 'download' ? [output, output + '.part', output + '.ldl', output + '.part.chunks'] : [output];
}

function targetResourcesConflict(resources: string[]): boolean {
  const keys = new Set(resources.map(downloadTargetKey));
  const conflicts = (existing: string[]) => existing.some(path => keys.has(downloadTargetKey(path)));
  return state.downloads.some(task => conflicts(targetResources(task.directory, task.fileName, 'download'))) ||
    state.magnets.some(task => conflicts(targetResources(task.directory, task.fileName, 'magnet')));
}

function numberedTargetName(baseName: string, number: number, maxLength: number): string {
  if (number === 0) return baseName;
  const extension = extname(baseName);
  const stem = baseName.slice(0, baseName.length - extension.length);
  const suffix = ' (' + number + ')';
  const stemLimit = Math.max(1, maxLength - extension.length - suffix.length);
  return (stem.slice(0, stemLimit).replace(/[. ]+$/g, '') || 'download') + suffix + extension;
}

async function reserveAvailableTargetName(
  directory: string,
  requestedName: string,
  kind: TargetNameKind,
): Promise<{ fileName: string; release: () => void }> {
  const baseName = kind === 'download'
    ? sanitizeDownloadFileName(requestedName)
    : validateMagnetFileName(requestedName);
  const maxLength = kind === 'download' ? 240 : 255;
  for (let number = 0; number < 100_000; number++) {
    const fileName = numberedTargetName(baseName, number, maxLength);
    const resources = targetResources(directory, fileName, kind);
    const keys = resources.map(downloadTargetKey);
    if (keys.some(key => pendingDownloadTargets.has(key)) || targetResourcesConflict(resources)) continue;

    // Reserve every final and sidecar path before the first filesystem await.
    // Concurrent task additions then move to the next suffix instead of both
    // choosing the same destination.
    for (const key of keys) pendingDownloadTargets.add(key);
    const release = () => { for (const key of keys) pendingDownloadTargets.delete(key); };
    try {
      let occupied = false;
      for (const path of resources) {
        const existing = await lstat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (existing) { occupied = true; break; }
      }
      // Recheck after asynchronous disk probes in case another task was added
      // while this reservation was being evaluated.
      if (occupied || targetResourcesConflict(resources)) {
        release();
        continue;
      }
      return { fileName, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  throw new Error('无法为下载任务分配可用的保存名称');
}

async function addMagnet(payload: Record<string, unknown>): Promise<MagnetTask> {
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  const identity = parseMagnetIdentity(url);
  ensureMagnetIsUnique(identity.infoHash);
  const metadata = await thunder.inspectMagnet(url, new AbortController().signal);
  if (metadata.infoHash !== identity.infoHash) throw new Error('迅雷解析结果与磁力链接不匹配');
  ensureMagnetIsUnique(identity.infoHash);
  const torrentFilePath = join(stateDirectory, 'metainfo', identity.infoHash + '.torrent');
  const directory = magnetDirectory(typeof payload.directory === 'string' ? payload.directory : null);
  const requestedName = typeof payload.fileName === 'string' && payload.fileName.trim() ? payload.fileName.trim() : metadata.name;
  const reservation = await reserveAvailableTargetName(directory, requestedName, 'magnet');
  try {
    const task = createMagnetTask(url, metadata, torrentFilePath, reservation.fileName, directory,
      Array.isArray(payload.selectedFileIndices) ? payload.selectedFileIndices.map(Number) : null);
    state.magnets.unshift(task); rememberTaskForScheduling('magnet:' + task.id); publish();
    setImmediate(startQueuedTasks);
    return task;
  } finally { reservation.release(); }
}
async function importTorrent(payload: Record<string, unknown>): Promise<MagnetTask> {
  const torrentPath = String(payload.torrentPath || '');
  if (!torrentPath) throw new Error('缺少种子文件路径');
  const result = await thunder.inspectTorrentFile(torrentPath);
  ensureMagnetIsUnique(result.metadata.infoHash);
  const directory = magnetDirectory(typeof payload.directory === 'string' ? payload.directory : null);
  const requestedName = typeof payload.fileName === 'string' && payload.fileName.trim() ? payload.fileName.trim() : result.metadata.name;
  const reservation = await reserveAvailableTargetName(directory, requestedName, 'magnet');
  try {
    const task = createMagnetTask(`torrent:${result.metadata.infoHash}`, result.metadata, result.torrentFilePath,
      reservation.fileName, directory,
      Array.isArray(payload.selectedFileIndices) ? payload.selectedFileIndices.map(Number) : null);
    state.magnets.unshift(task); rememberTaskForScheduling('magnet:' + task.id); publish();
    setImmediate(startQueuedTasks);
    return task;
  } finally { reservation.release(); }
}

async function dispatch(method: WorkerMethod, payload: unknown): Promise<unknown> {
  const args = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'tasks:list': return snapshot();
    case 'tasks:export-proxy-secrets': { const username = legacyProxyUsername; legacyProxyUsername = null; return { username, password: null }; }
    case 'tasks:set-proxy-credentials': {
      const username = args.username; const password = args.password;
      if (username !== null && typeof username !== 'string' || password !== null && typeof password !== 'string') throw new Error('代理凭据格式无效');
      proxyCredentials = { username: username as string | null, password: password as string | null };
      return true;
    }
    case 'tasks:export-input-secrets': {
      const secretKeys = ['headers', 'cookie', 'referer', 'userAgent', 'authScheme', 'authUsername', 'authPassword', 'allowInsecureAuth'];
      return Object.fromEntries(Object.entries(state.downloadInputs).map(([id, input]) => {
        const secret = Object.fromEntries(secretKeys.filter(key => input[key as keyof AddDownloadInput] != null && input[key as keyof AddDownloadInput] !== '').map(key => [key, input[key as keyof AddDownloadInput]]));
        return [id, secret];
      }).filter(([, secret]) => Object.keys(secret as object).length > 0));
    }
    case 'tasks:restore-input-secrets': {
      const values = args.secrets;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('下载凭据恢复数据格式无效');
      for (const [id, secret] of Object.entries(values as Record<string, AddDownloadInput>)) {
        if (!state.downloads.some(task => task.id === id) || !secret || typeof secret !== 'object' || Array.isArray(secret)) continue;
        state.downloadInputs[id] = { ...(state.downloadInputs[id] || { url: state.downloads.find(task => task.id === id)!.url }), ...secret };
      }
      publish();
      startQueuedTasks();
      return true;
    }
    case 'tasks:inspect-url': return inspectDownload(args as unknown as AddDownloadInput);
    case 'tasks:add': {
      const input = args as unknown as AddDownloadInput;
      const parsed = new URL(input.url);
      if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error('普通下载只接收不含内嵌凭据的 HTTP、HTTPS、FTP 或 FTPS 链接');
      }
      const sourceKey = downloadSourceIdentity(parsed.href);
      const duplicate = findDuplicateDownloadSource(state.downloads, parsed.href);
      if (duplicate) throw new Error('下载任务已存在：' + duplicate.fileName);
      if (pendingDownloadSources.has(sourceKey)) throw new Error('相同下载任务正在添加中');
      pendingDownloadSources.add(sourceKey);
      try {
        const metadata = await inspectDownload(input);
        const directory = input.directory?.trim() || state.downloadSettings.defaultDownloadDirectory || join(homedir(), 'Downloads');
        const requestedName = sanitizeDownloadFileName(input.fileName?.trim() || metadata.fileName);
        const reservation = await reserveAvailableTargetName(directory, requestedName, 'download');
        try {
          const fileName = reservation.fileName;
          const duplicateAfterInspect = findDuplicateDownloadSource(state.downloads, parsed.href);
          if (duplicateAfterInspect) throw new Error('下载任务已存在：' + duplicateAfterInspect.fileName);
          const now = Date.now();
          const task: DownloadTask = {
            id: typeof input.taskId === 'string' && /^[0-9a-f-]{36}$/i.test(input.taskId) ? input.taskId : randomUUID(), url: parsed.href, fileName,
            directory,
            status: 'queued', totalBytes: metadata.totalBytes, downloadedBytes: 0, segments: [], speedBytesSec: 0,
            error: null, expectedChecksum: input.expectedChecksum ?? null, checksumAlgorithm: input.checksumAlgorithm || 'sha256',
            category: input.category || 'other', categoryAuto: !input.category, contentType: metadata.contentType,
            scheduledAt: input.scheduledAt ?? null, repeatIntervalSeconds: input.repeatIntervalSeconds ?? null,
            repeatFileName: null, queueName: input.queueName || '默认', credentialKey: null, etag: metadata.etag,
            lastModified: metadata.lastModified, speedLimitBytesSec: input.speedLimitBytesSec ? Math.round(input.speedLimitBytesSec) : null, createdAt: now, updatedAt: now,
          };
          const { taskId: _taskId, ...savedInput } = input;
          state.downloadInputs[task.id] = { ...savedInput, url: parsed.href, fileName };
          state.downloads.unshift(task); rememberTaskForScheduling(task.id); publish(); startQueuedTasks(); return task;
        } finally { reservation.release(); }
      } finally {
        pendingDownloadSources.delete(sourceKey);
      }
    }
    case 'tasks:pause': {
      const task = getTask(String(args.id));
      const controller = downloadControllers.get(task.id);
      if (controller) {
        controller.abort();
        await downloadRuns.get(task.id);
      } else if (task.status === 'queued') {
        task.status = 'paused'; task.updatedAt = Date.now(); publish();
      }
      startQueuedTasks();
      return;
    }
    case 'tasks:resume': {
      const task = getTask(String(args.id));
      if (task.status === 'paused' || task.status === 'failed') {
        task.status = 'queued'; task.error = null; task.updatedAt = Date.now(); publish(); startQueuedTasks();
      }
      return;
    }
    case 'tasks:pause-all': {
      const ids = new Set(Array.isArray(args.taskIds) ? args.taskIds.filter((id): id is string => typeof id === 'string') : []);
      const runs: Promise<void>[] = [];
      schedulerSuspended += 1;
      if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
      try {
        for (const rawId of ids) {
          if (rawId.startsWith('magnet:')) {
            const id = rawId.slice('magnet:'.length);
            const task = state.magnets.find(candidate => candidate.id === id);
            if (!task || task.status === 'completed') continue;
            const controller = magnetControllers.get(id);
            if (controller) {
              controller.abort();
              const run = magnetRuns.get(id);
              if (run) runs.push(run);
            } else if (task.status === 'queued') {
              task.status = 'paused'; task.speedBytesSec = 0; task.phase = null; task.updatedAt = Date.now();
            }
            continue;
          }
          const task = state.downloads.find(candidate => candidate.id === rawId);
          if (!task || task.status === 'completed') continue;
          const controller = downloadControllers.get(task.id);
          if (controller) {
            controller.abort();
            const run = downloadRuns.get(task.id);
            if (run) runs.push(run);
          } else if (task.status === 'queued') {
            task.status = 'paused'; task.speedBytesSec = 0;
            task.segments = task.segments.map(segment => ({ ...segment, active: false }));
            task.updatedAt = Date.now();
          }
        }
        publish();
        await Promise.all(runs);
      } finally {
        schedulerSuspended = Math.max(0, schedulerSuspended - 1);
        if (schedulerSuspended === 0) startQueuedTasks();
      }
      return;
    }
    case 'tasks:start-all': {
      const currentOrder = schedulerTaskIds();
      const available = new Set(currentOrder);
      const requested = Array.isArray(args.taskIds) ? args.taskIds.filter((id): id is string => typeof id === 'string' && available.has(id)) : [];
      const requestedUnique = [...new Set(requested)];
      const selected = new Set(requestedUnique);
      state.schedulerOrder = [...requestedUnique, ...currentOrder.filter(id => !selected.has(id))];
      for (const task of state.downloads) {
        if (task.status === 'paused' || task.status === 'failed') { task.status = 'queued'; task.error = null; task.updatedAt = Date.now(); }
      }
      for (const task of state.magnets) {
        if (task.status === 'paused' || task.status === 'failed') { task.status = 'queued'; task.phase = 'waiting_engine'; task.error = null; task.updatedAt = Date.now(); }
      }
      publish(); startQueuedTasks(); return;
    }
    case 'tasks:resume-order': {
      const failures: string[] = [];
      for (const id of Array.isArray(args.ids) ? args.ids.map(String) : []) {
        try { await dispatch('tasks:resume', { id }); } catch (error) { failures.push(String(id) + ': ' + String(error)); }
      }
      return failures;
    }
    case 'tasks:remove': {
      const id = String(args.id);
      const task = getTask(id);
      const controller = downloadControllers.get(id);
      if (controller) { controller.abort(); await downloadRuns.get(id); }
      if (Boolean(args.deleteFiles)) await removeDownloadFiles(task);
      state.downloadInputs = Object.fromEntries(Object.entries(state.downloadInputs).filter(([key]) => key !== id));
      state.downloads = state.downloads.filter(candidate => candidate.id !== id);
      forgetTaskFromScheduling(id);
      publish(); startQueuedTasks(); return;
    }
    case 'tasks:set-category': {
      const task = getTask(String(args.id)); task.category = String(args.category).slice(0, 80); task.categoryAuto = false;
      task.updatedAt = Date.now(); publish(); return;
    }
    case 'tasks:set-queue': {
      const task = getTask(String(args.id)); task.queueName = String(args.queueName).slice(0, 80);
      task.updatedAt = Date.now(); publish(); startQueuedTasks(); return;
    }
    case 'tasks:import-torrent': return importTorrent(args);
    case 'tasks:download-settings': return state.downloadSettings;
    case 'tasks:update-download-settings': {
      const update = args as Partial<DownloadSettings>;
      const segmentsPerDownload = normalizeDownloadSegmentCount(update.segmentsPerDownload, state.downloadSettings.segmentsPerDownload);
      state.downloadSettings = { ...state.downloadSettings, ...update, segmentsPerDownload, autoSegmentDownloads: segmentsPerDownload > 1, proxyUsername: null };
      if (update.queues) state.downloadSettings.queues = update.queues;
      publish(); startQueuedTasks(); return state.downloadSettings;
    }
    case 'tasks:magnet-settings': return state.magnetSettings;
    case 'tasks:update-magnet-settings': {
      const update = args as Partial<MagnetSettings>;
      state.magnetSettings = { ...state.magnetSettings, ...update, torrentEngine: 'thunder', bundledSdkDirectory: process.env.LDOWNLOAD_THUNDER_BUNDLED_SDK_DIR || null };
      publish(); return state.magnetSettings;
    }
    case 'magnets:list': return state.magnets;
    case 'magnets:inspect': return inspectMagnet(String(args.url || ''), typeof args.torrentPath === 'string' ? args.torrentPath : null);
    case 'magnets:inspect-task': {
      const task = getMagnet(String(args.id));
      if (!task.torrentFilePath) throw new Error('任务缺少已校验的种子元数据');
      return makePreview(await thunder.loadTorrentFile(task.torrentFilePath, task.infoHash));
    }
    case 'magnets:add': return addMagnet(args);
    case 'magnets:update-selection': {
      const task = getMagnet(String(args.id));
      if (task.status === 'completed') throw new Error('已完成的磁力任务不能修改文件选择');
      const torrentFilePath = task.torrentFilePath;
      if (!torrentFilePath) throw new Error('任务缺少已校验的种子元数据');
      const indices = Array.isArray(args.selectedFileIndices) ? args.selectedFileIndices.map(Number) : [];
      if (!indices.length || new Set(indices).size !== indices.length) throw new Error('请至少选择一个不重复的文件');
      const metadata = await thunder.loadTorrentFile(torrentFilePath, task.infoHash);
      if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= metadata.files.length)) throw new Error('磁力文件选择无效');
      const newTotal = selectedBytes({ selectedFileIndices: indices } as MagnetTask, metadata);
      const controller = magnetControllers.get(task.id);
      if (controller) {
        controller.abort();
        await magnetRuns.get(task.id);
      }
      if (getMagnet(task.id).status === 'completed') throw new Error('已完成的磁力任务不能修改文件选择');
      await thunder.retainSelectedFiles({ ...task, torrentFilePath }, indices);
      task.selectedFileIndices = indices; task.totalBytes = newTotal; task.downloadedBytes = 0;
      task.speedBytesSec = 0; task.status = 'queued'; task.error = null; task.phase = 'waiting_engine'; task.updatedAt = Date.now(); publish();
      setImmediate(startQueuedTasks);
      return;
    }
    case 'magnets:pause': {
      const task = getMagnet(String(args.id));
      magnetControllers.get(task.id)?.abort();
      await magnetRuns.get(task.id);
      if (task.status === 'queued' || task.status === 'downloading') task.status = 'paused';
      task.speedBytesSec = 0; task.phase = null; task.updatedAt = Date.now(); publish(); startQueuedTasks(); return;
    }
    case 'magnets:resume': {
      const task = getMagnet(String(args.id));
      if (task.status === 'paused' || task.status === 'failed') {
        task.status = 'queued'; task.error = null; task.phase = 'waiting_engine'; task.updatedAt = Date.now(); publish();
        setImmediate(startQueuedTasks);
      }
      return;
    }
    case 'magnets:remove': {
      const id = String(args.id);
      const task = getMagnet(id);
      magnetControllers.get(id)?.abort();
      await magnetRuns.get(id);
      const torrentFilePath = task.torrentFilePath;
      if (!torrentFilePath) throw new Error('任务缺少已校验的种子元数据');
      await thunder.removeTaskFiles({ ...task, torrentFilePath }, Boolean(args.deleteFiles));
      state.magnets = state.magnets.filter(task => task.id !== id);
      forgetTaskFromScheduling('magnet:' + id);
      publish(); startQueuedTasks(); return;
    }
  }
}

parentPort?.once('message', async event => {
  const connectedPort = event.ports[0];
  if (!connectedPort) return;
  port = connectedPort;
  await restoreState();
  port.on('message', event => {
    const request = event.data;
    void dispatch(request.method, request.payload).then(value => {
      const reply: WorkerReply = { id: request.id, ok: true, value };
      port.postMessage(reply);
    }).catch(error => {
      const reply: WorkerReply = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      port.postMessage(reply);
    });
  });
  port.start();
  if (removedLegacySettings) persistState();
  port.postMessage({ type: 'ready', snapshot: snapshot() });
});
