import type {
  AddDownloadInput,
  CollectionSnapshot,
  DownloadMetadata,
  DownloadSettings,
  DownloadTask,
  DialogRequest,
  EngineCapabilities,
  MagnetFilePreview,
  MagnetSettings,
  MagnetTask,
  SiteCollectionInput,
  SiteCollectionProject,
  TaskLogEntry,
} from './contracts';

export interface IpcRequestMap {
  'downloads:list': undefined;
  'downloads:task-logs': { id: string };
  'downloads:inspect-url': AddDownloadInput;
  'downloads:add': AddDownloadInput;
  'downloads:pause': { id: string };
  'downloads:resume': { id: string };
  'downloads:resume-order': { ids: string[] };
  'downloads:start-all': { taskIds: string[] };
  'downloads:pause-all': { taskIds: string[] };
  'downloads:remove': { id: string; deleteFiles: boolean };
  'downloads:set-category': { id: string; category: string };
  'downloads:set-queue': { id: string; queueName: string };
  'downloads:create-queue': { name: string };
  'downloads:set-queue-paused': { name: string; paused: boolean };
  'downloads:delete-queue': { name: string };
  'downloads:settings': undefined;
  'downloads:update-settings': Partial<DownloadSettings> & { proxyPassword?: string | null };
  'downloads:read-link-list': { filePath: string };
  'downloads:import-torrent': { torrentPath: string; directory?: string | null; fileName?: string | null; selectedFileIndices?: number[] | null };
  'downloads:copy-link': { id: string };
  'downloads:open-task': { id: string; target: 'file' | 'folder' };
  'downloads:completion-action': { action: string };
  'system:take-torrent-prompts': undefined;
  'magnets:list': undefined;
  'magnets:inspect': { url: string; torrentPath: string | null };
  'magnets:inspect-task': { id: string };
  'magnets:add': {
    url: string;
    fileName?: string | null;
    directory?: string | null;
    selectedFileIndices?: number[] | null;
  };
  'magnets:update-selection': { id: string; selectedFileIndices: number[] };
  'magnets:pause': { id: string };
  'magnets:resume': { id: string };
  'magnets:remove': { id: string; deleteFiles: boolean };
  'magnets:open-folder': { id: string };
  'magnets:settings': undefined;
  'magnets:update-settings': Partial<MagnetSettings>;
  'site-collections:list': undefined;
  'site-collections:create': SiteCollectionInput;
  'site-collections:run': { id: string };
  'site-collections:stop': { id: string };
  'site-collections:delete': { id: string };
  'site-collections:add-links': { id: string; links: string[]; queueName: string };
  'browser:install-native-host': { browser: 'chrome' | 'edge' | 'firefox'; extensionId: string };
  'browser:open-extension-folder': { browser: 'chrome' | 'edge' | 'firefox' };
  'system:default-directory': undefined;
  'system:read-clipboard': undefined;
  'system:register-protocols': undefined;
  'system:choose-file': Exclude<DialogRequest, { kind: 'directory' }>;
  'system:choose-directory': { kind: 'directory'; defaultPath?: string };
  'system:copy-text': { text: string };
  'system:capabilities': undefined;
  'window:minimize': undefined;
  'window:toggle-maximize': undefined;
  'window:close': undefined;
  'window:is-maximized': undefined;
}

export interface IpcResponseMap {
  'downloads:list': DownloadTask[];
  'downloads:task-logs': TaskLogEntry[];
  'downloads:inspect-url': DownloadMetadata;
  'downloads:add': DownloadTask;
  'downloads:pause': void;
  'downloads:resume': void;
  'downloads:resume-order': string[];
  'downloads:start-all': void;
  'downloads:pause-all': void;
  'downloads:remove': void;
  'downloads:set-category': void;
  'downloads:set-queue': void;
  'downloads:create-queue': DownloadSettings;
  'downloads:set-queue-paused': DownloadSettings;
  'downloads:delete-queue': DownloadSettings;
  'downloads:settings': DownloadSettings;
  'downloads:update-settings': DownloadSettings;
  'downloads:read-link-list': string[];
  'downloads:import-torrent': MagnetTask;
  'downloads:copy-link': void;
  'downloads:open-task': void;
  'downloads:completion-action': void;
  'system:take-torrent-prompts': string[];
  'magnets:list': MagnetTask[];
  'magnets:inspect': MagnetFilePreview;
  'magnets:inspect-task': MagnetFilePreview;
  'magnets:add': MagnetTask;
  'magnets:update-selection': void;
  'magnets:pause': void;
  'magnets:resume': void;
  'magnets:remove': void;
  'magnets:open-folder': void;
  'magnets:settings': MagnetSettings;
  'magnets:update-settings': MagnetSettings;
  'site-collections:list': SiteCollectionProject[];
  'site-collections:create': SiteCollectionProject;
  'site-collections:run': SiteCollectionProject[];
  'site-collections:stop': SiteCollectionProject[];
  'site-collections:delete': SiteCollectionProject[];
  'site-collections:add-links': { added: number; failed: number };
  'browser:install-native-host': boolean;
  'browser:open-extension-folder': void;
  'system:default-directory': string;
  'system:read-clipboard': string;
  'system:register-protocols': boolean;
  'system:choose-file': string | null;
  'system:choose-directory': string | null;
  'system:copy-text': void;
  'system:capabilities': EngineCapabilities[];
  'window:minimize': void;
  'window:toggle-maximize': void;
  'window:close': void;
  'window:is-maximized': boolean;
}

export interface IpcEventMap {
  'downloads:updated': DownloadTask[];
  'magnets:updated': MagnetTask[];
  'site-collections:updated': CollectionSnapshot;
  'engine:status': { state: 'starting' | 'ready' | 'restarting' | 'failed'; message?: string };
  'system:open-link': { url: string };
  'system:torrent-prompt-available': undefined;
  'system:clipboard-link': { url: string };
  'downloads:completion-action-required': { action: 'exit' | 'shutdown' };
  'window:maximized-changed': boolean;
}

export type IpcChannel = keyof IpcRequestMap;

export interface RendererApi {
  downloads: {
    list(): Promise<DownloadTask[]>;
    getTaskLogs(id: string): Promise<TaskLogEntry[]>;
    inspectUrl(input: AddDownloadInput): Promise<DownloadMetadata>;
    add(input: AddDownloadInput): Promise<DownloadTask>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    resumeInOrder(ids: string[]): Promise<string[]>;
    startAll(taskIds: string[]): Promise<void>;
    pauseAll(taskIds: string[]): Promise<void>;
    remove(id: string, deleteFiles: boolean): Promise<void>;
    setCategory(id: string, category: string): Promise<void>;
    setQueue(id: string, queueName: string): Promise<void>;
    createQueue(name: string): Promise<DownloadSettings>;
    setQueuePaused(name: string, paused: boolean): Promise<DownloadSettings>;
    deleteQueue(name: string): Promise<DownloadSettings>;
    getSettings(): Promise<DownloadSettings>;
    updateSettings(settings: Partial<DownloadSettings> & { proxyPassword?: string | null }): Promise<DownloadSettings>;
    readLinkList(filePath: string): Promise<string[]>;
    importTorrent(input: IpcRequestMap['downloads:import-torrent']): Promise<MagnetTask>;
    copyLink(id: string): Promise<void>;
    openTask(id: string, target: 'file' | 'folder'): Promise<void>;
    executeCompletionAction(action: string): Promise<void>;
    onCompletionActionRequired(callback: (payload: IpcEventMap['downloads:completion-action-required']) => void): () => void;
    onUpdated(callback: (tasks: DownloadTask[]) => void): () => void;
  };
  magnets: {
    list(): Promise<MagnetTask[]>;
    inspect(url: string, torrentPath?: string | null): Promise<MagnetFilePreview>;
    inspectTask(id: string): Promise<MagnetFilePreview>;
    add(input: IpcRequestMap['magnets:add']): Promise<MagnetTask>;
    updateSelection(id: string, selectedFileIndices: number[]): Promise<void>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    remove(id: string, deleteFiles: boolean): Promise<void>;
    openFolder(id: string): Promise<void>;
    getSettings(): Promise<MagnetSettings>;
    updateSettings(settings: Partial<MagnetSettings>): Promise<MagnetSettings>;
    onUpdated(callback: (tasks: MagnetTask[]) => void): () => void;
  };
  siteCollections: {
    list(): Promise<SiteCollectionProject[]>;
    create(input: SiteCollectionInput): Promise<SiteCollectionProject>;
    run(id: string): Promise<SiteCollectionProject[]>;
    stop(id: string): Promise<SiteCollectionProject[]>;
    delete(id: string): Promise<SiteCollectionProject[]>;
    addLinks(id: string, links: string[], queueName: string): Promise<{ added: number; failed: number }>;
    onUpdated(callback: (snapshot: CollectionSnapshot) => void): () => void;
  };
  system: {
    defaultDirectory(): Promise<string>;
    readClipboardText(): Promise<string>;
    registerProtocols(): Promise<boolean>;
    installNativeHost(browser: 'chrome' | 'edge' | 'firefox', extensionId: string): Promise<boolean>;
    openExtensionFolder(browser: 'chrome' | 'edge' | 'firefox'): Promise<void>;
    onOpenLink(callback: (payload: IpcEventMap['system:open-link']) => void): () => void;
    onClipboardLink(callback: (payload: IpcEventMap['system:clipboard-link']) => void): () => void;
    takeTorrentPrompts(): Promise<string[]>;
    onTorrentPromptAvailable(callback: () => void): () => void;
    chooseFile(request: Exclude<DialogRequest, { kind: 'directory' }>): Promise<string | null>;
    chooseDirectory(defaultPath?: string): Promise<string | null>;
    copyText(text: string): Promise<void>;
    capabilities(): Promise<EngineCapabilities[]>;
    onEngineStatus(callback: (status: IpcEventMap['engine:status']) => void): () => void;
    minimizeWindow(): Promise<void>;
    toggleMaximizeWindow(): Promise<void>;
    closeWindow(): Promise<void>;
    isWindowMaximized(): Promise<boolean>;
    onWindowMaximizedChanged(callback: (maximized: boolean) => void): () => void;
  };
}

declare global {
  interface Window {
    ldownload: RendererApi;
    LDownloadTasks: {
      invoke: <K extends keyof import('./contracts').LegacyCommandMap>(
        command: K,
        args?: import('./contracts').LegacyCommandMap[K],
      ) => Promise<unknown>;
      isMagnet(value: unknown): boolean;
      isSupported(value: unknown): boolean;
      getMagnetError(): string | null;
      openDialog(options: {
        directory?: boolean;
        multiple?: boolean;
        filters?: Array<{ name: string; extensions: string[] }>;
        defaultPath?: string;
        title?: string;
      }): Promise<string | string[] | null>;
      subscribe(callback: (tasks: Array<DownloadTask | MagnetTask & { kind: 'magnet' }>) => void): Promise<() => void>;
      subscribeCollections(callback: (projects: SiteCollectionProject[]) => void): Promise<() => void>;
    };
    LDownloadApiBridge: {
      invoke: Window['LDownloadTasks']['invoke'];
      dialog: { open: Window['LDownloadTasks']['openDialog'] };
      event: {
        listen(name: string, callback: (event: { payload: unknown }) => void): Promise<() => void>;
      };
    };
  }
}
