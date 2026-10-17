export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'scanning'
  | 'paused'
  | 'completed'
  | 'failed';

export type MagnetStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';

export interface DownloadSegment {
  index: number;
  downloadedBytes: number;
  totalBytes: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  active: boolean;
}

export interface DownloadTask {
  id: string;
  url: string;
  fileName: string;
  directory: string;
  status: DownloadStatus;
  totalBytes: number | null;
  downloadedBytes: number;
  segments: DownloadSegment[];
  speedBytesSec: number;
  speedLimitBytesSec: number | null;
  error: string | null;
  expectedChecksum: string | null;
  checksumAlgorithm: string;
  category: string;
  categoryAuto: boolean;
  contentType: string | null;
  scheduledAt: number | null;
  repeatIntervalSeconds: number | null;
  repeatFileName: string | null;
  queueName: string;
  credentialKey: string | null;
  etag: string | null;
  lastModified: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MagnetTask {
  id: string;
  url: string;
  infoHash: string;
  fileName: string;
  directory: string;
  torrentFilePath: string | null;
  selectedFileIndices: number[] | null;
  downloadEngine: string;
  bundledSdkDirectory: string | null;
  status: MagnetStatus;
  totalBytes: number | null;
  downloadedBytes: number;
  speedBytesSec: number;
  error: string | null;
  phase: string | null;
  livePeers: number;
  dhtNodes: number;
  diagnostics: {
    discoveredPeers: number;
    trackerSuccesses: number;
    trackerFailures: number;
    connectionAttempts: number;
    peerRetries: number;
    blockedPeers: number;
    lastNetworkError: string | null;
  };
  createdAt: number;
  updatedAt: number;
}

export interface MagnetFileInfo {
  index: number;
  path: string;
  size: number;
}

export interface MagnetFilePreview {
  infoHash: string;
  name: string;
  totalBytes: number;
  files: MagnetFileInfo[];
}

export interface DownloadQueue {
  name: string;
  paused: boolean;
}

export interface DownloadSettings {
  maxConcurrentDownloads: number;
  /** Fixed number of HTTP byte ranges to download in parallel. */
  segmentsPerDownload: DownloadSegmentCount;
  /** @deprecated Kept for persisted-state and IPC compatibility; use segmentsPerDownload. */
  autoSegmentDownloads: boolean;
  connectTimeoutSeconds: number;
  maxRetries: number;
  speedLimitBytesSec: number;
  defaultDownloadDirectory: string | null;
  proxyMode: 'system' | 'custom' | 'disabled';
  proxyUrl: string | null;
  proxyUsername: string | null;
  allowInsecureProxyAuth: boolean;
  visibleColumns: string[];
  completionAction: 'none' | 'open_file' | 'open_folder' | 'exit' | 'shutdown';
  clipboardMonitorEnabled: boolean;
  virusScannerPath: string | null;
  virusScannerArguments: string[];
  language: 'zh-CN' | 'en-US';
  toolbarButtons: string[];
  minimizeToTray: boolean;
  launchAtLogin: boolean;
  queues: DownloadQueue[];
}

export const DOWNLOAD_SEGMENT_OPTIONS = [1, 2, 4, 8, 16, 32] as const;
export type DownloadSegmentCount = typeof DOWNLOAD_SEGMENT_OPTIONS[number];

export function normalizeDownloadSegmentCount(value: unknown, fallback: DownloadSegmentCount = 8): DownloadSegmentCount {
  return DOWNLOAD_SEGMENT_OPTIONS.includes(value as DownloadSegmentCount)
    ? value as DownloadSegmentCount
    : fallback;
}

/**
 * Rebuild a stable logical segment view from persisted range progress.
 * Older engine versions exposed every internal scheduler lease as a segment,
 * so a paused task could retain dozens of UI segments even when the user's
 * configured count was eight. Progress is projected by intersecting the
 * received prefixes with the new logical ranges; merged intervals prevent
 * overlapping legacy leases from counting the same bytes twice.
 */
export function regroupDownloadSegments(
  segments: readonly DownloadSegment[],
  totalBytes: number,
  segmentCount: number,
): DownloadSegment[] | null {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 ||
      !Number.isSafeInteger(segmentCount) || segmentCount < 1) return null;

  const count = Math.min(segmentCount, totalBytes);
  const received: Array<{ start: number; end: number }> = [];
  for (const segment of segments) {
    const start = segment.rangeStart;
    const end = segment.rangeEnd;
    if (typeof start !== 'number' || typeof end !== 'number' ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) continue;
    const length = Math.min(end - start + 1, Math.max(0, Math.floor(segment.downloadedBytes)));
    if (length > 0) received.push({ start, end: start + length - 1 });
  }
  if (segments.some(segment => segment.downloadedBytes > 0) && received.length === 0) return null;

  received.sort((left, right) => left.start - right.start);
  const covered: Array<{ start: number; end: number }> = [];
  for (const interval of received) {
    const previous = covered[covered.length - 1];
    if (previous && interval.start <= previous.end + 1) previous.end = Math.max(previous.end, interval.end);
    else covered.push({ ...interval });
  }

  return Array.from({ length: count }, (_, index) => {
    // BigInt keeps byte boundaries exact for large files.
    const start = Number(BigInt(totalBytes) * BigInt(index) / BigInt(count));
    const end = Number(BigInt(totalBytes) * BigInt(index + 1) / BigInt(count)) - 1;
    const downloadedBytes = covered.reduce((sum, interval) =>
      sum + Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start) + 1), 0);
    return {
      index,
      downloadedBytes: Math.min(end - start + 1, downloadedBytes),
      totalBytes: end - start + 1,
      rangeStart: start,
      rangeEnd: end,
      active: false,
    };
  });
}

export interface MagnetSettings {
  magnetRetryDelaySeconds: number;
  torrentUpnpEnabled: boolean;
  torrentPublicTrackersEnabled: boolean;
  torrentEngine: 'thunder';
  bundledSdkDirectory: string | null;
  defaultDownloadDirectory: string | null;
  virusScannerPath: string | null;
  virusScannerArguments: string[];
}

export interface DownloadMetadata {
  fileName: string;
  contentType: string | null;
  totalBytes: number | null;
  supportsRanges: boolean;
}

export interface SiteCollectionProject {
  id: string;
  startUrl: string;
  maxDepth: number;
  pageLimit: number;
  includePatterns: string[];
  excludePatterns: string[];
  fileExtensions: string[];
  frontier: Array<{ url: string; depth: number }>;
  visitedPages: string[];
  foundLinks: string[];
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped';
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DialogRequest =
  | { kind: 'import' }
  | { kind: 'torrent' }
  | { kind: 'link-list' }
  | { kind: 'directory'; defaultPath?: string };

export interface AddDownloadInput {
  url: string;
  taskId?: string;
  fileName?: string | null;
  directory?: string | null;
  expectedChecksum?: string | null;
  checksumAlgorithm?: string;
  category?: string;
  queueName?: string;
  scheduledAt?: number | null;
  repeatIntervalSeconds?: number | null;
  speedLimitBytesSec?: number | null;
  headers?: Record<string, string>;
  cookie?: string | null;
  referer?: string | null;
  userAgent?: string | null;
  authScheme?: string | null;
  authUsername?: string | null;
  authPassword?: string | null;
  allowInsecureAuth?: boolean;
}

export interface EngineCapabilities {
  id: 'http' | 'ftp' | 'thunder-sdk';
  displayName: string;
  protocols: string[];
  platforms: string[];
  available: boolean;
  reason?: string;
}

export type TaskLogLevel = 'info' | 'warn' | 'error';

export interface TaskLogEntry {
  timestamp: string;
  level: TaskLogLevel;
  code: string;
  message: string;
}

export interface TaskSnapshot {
  revision: number;
  downloads: DownloadTask[];
  magnets: MagnetTask[];
}

export interface CollectionSnapshot {
  revision: number;
  projects: SiteCollectionProject[];
}

export interface EngineCommandMap {
  'tasks:list': undefined;
  'tasks:inspect-url': AddDownloadInput;
  'tasks:add': AddDownloadInput;
  'tasks:pause': { id: string };
  'tasks:resume': { id: string };
  'tasks:resume-order': { ids: string[] };
  'tasks:remove': { id: string; deleteFiles: boolean };
  'tasks:set-category': { id: string; category: string };
  'tasks:set-queue': { id: string; queueName: string };
  'tasks:import-torrent': { torrentPath: string; directory?: string | null };
  'tasks:inspect-magnet': { url: string; torrentPath: string | null };
  'tasks:update-magnet-selection': { id: string; selectedFileIndices: number[] };
  'tasks:magnet-settings': undefined;
  'tasks:update-magnet-settings': Partial<MagnetSettings>;
  'tasks:download-settings': undefined;
  'tasks:update-download-settings': Partial<DownloadSettings>;
}

export type EngineCommandName = keyof EngineCommandMap;

export type EngineResponseMap = {
  'tasks:list': TaskSnapshot;
  'tasks:inspect-url': DownloadMetadata;
  'tasks:add': DownloadTask | MagnetTask;
  'tasks:pause': void;
  'tasks:resume': void;
  'tasks:resume-order': string[];
  'tasks:remove': void;
  'tasks:set-category': void;
  'tasks:set-queue': void;
  'tasks:import-torrent': MagnetTask;
  'tasks:inspect-magnet': MagnetFilePreview;
  'tasks:update-magnet-selection': void;
  'tasks:magnet-settings': MagnetSettings;
  'tasks:update-magnet-settings': MagnetSettings;
  'tasks:download-settings': DownloadSettings;
  'tasks:update-download-settings': DownloadSettings;
};

export interface SiteCollectionInput {
  startUrl: string;
  maxDepth: number;
  pageLimit: number;
  includePatterns: string[];
  excludePatterns: string[];
  fileExtensions: string[];
}

export interface LegacyCommandMap {
  list_downloads: undefined;
  list_magnet_downloads: undefined;
  default_download_directory: undefined;
  inspect_download_url: {
    url: string;
    authScheme?: string | null;
    authUsername?: string | null;
    authPassword?: string | null;
    allowInsecureAuth?: boolean;
  };
  add_download: AddDownloadInput;
  pause_download: { id: string };
  resume_download: { id: string };
  resume_downloads_in_order: { ids: string[] };
  remove_download: { id: string; deleteFile?: boolean };
  set_download_category: { id: string; category: string };
  set_download_task_queue: { id: string; queueName: string };
  create_download_queue: { name: string };
  set_download_queue_paused: { name: string; paused: boolean };
  delete_download_queue: { name: string };
  import_torrent_download: { torrentPath: string; directory?: string | null };
  inspect_magnet_files: { url: string; torrentPath?: string | null };
  update_magnet_file_selection: { id: string; selectedFileIndices: number[] };
  add_magnet_download: {
    url: string;
    fileName?: string | null;
    directory?: string | null;
    selectedFileIndices?: number[] | null;
  };
  pause_magnet_download: { id: string };
  resume_magnet_download: { id: string };
  remove_magnet_download: { id: string; deleteFiles?: boolean };
  get_magnet_settings: undefined;
  update_magnet_settings: { settings: Partial<MagnetSettings> };
  get_download_settings: undefined;
  update_download_settings: { settings: Partial<DownloadSettings> };
  read_download_list_links: { filePath: string };
  copy_download_link: { id: string };
  copy_magnet_link: { id: string };
  open_download_file: { id: string };
  show_download_folder: { id: string };
  open_magnet_folder: { id: string };
  execute_completion_action: { action: string };
  list_site_collections: undefined;
  create_site_collection: SiteCollectionInput;
  run_site_collection: { id: string };
  stop_site_collection: { id: string };
  delete_site_collection: { id: string };
  add_site_collection_links: { id: string; links: string[]; queueName: string };
  register_browser_link_handler: undefined;
  install_browser_native_host: { browser: string; extensionId: string };
  open_browser_extension_folder: { browser: string };
}
