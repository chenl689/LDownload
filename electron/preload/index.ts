import { contextBridge, ipcRenderer } from 'electron';
import type {
  DownloadSettings,
  MagnetSettings,
  SiteCollectionInput,
} from '../../src/shared/contracts';
import type {
  IpcEventMap,
  IpcRequestMap,
  IpcResponseMap,
  RendererApi,
} from '../../src/shared/ipc';

function invoke<K extends keyof IpcRequestMap>(
  channel: K,
  ...args: IpcRequestMap[K] extends undefined ? [] : [IpcRequestMap[K]]
): Promise<IpcResponseMap[K]> {
  return ipcRenderer.invoke(channel, args[0]) as Promise<IpcResponseMap[K]>;
}

function subscribe<K extends keyof IpcEventMap>(
  channel: K,
  callback: (payload: IpcEventMap[K]) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: IpcEventMap[K]) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: RendererApi = {
  downloads: {
    list: () => invoke('downloads:list'),
    getTaskLogs: id => invoke('downloads:task-logs', { id }),
    inspectUrl: input => invoke('downloads:inspect-url', input),
    add: input => invoke('downloads:add', input),
    pause: id => invoke('downloads:pause', { id }),
    resume: id => invoke('downloads:resume', { id }),
    resumeInOrder: ids => invoke('downloads:resume-order', { ids }),
    startAll: taskIds => invoke('downloads:start-all', { taskIds }),
    pauseAll: taskIds => invoke('downloads:pause-all', { taskIds }),
    remove: (id, deleteFiles) => invoke('downloads:remove', { id, deleteFiles }),
    setCategory: (id, category) => invoke('downloads:set-category', { id, category }),
    setQueue: (id, queueName) => invoke('downloads:set-queue', { id, queueName }),
    createQueue: name => invoke('downloads:create-queue', { name }),
    setQueuePaused: (name, paused) => invoke('downloads:set-queue-paused', { name, paused }),
    deleteQueue: name => invoke('downloads:delete-queue', { name }),
    getSettings: () => invoke('downloads:settings'),
    updateSettings: (settings: Partial<DownloadSettings> & { proxyPassword?: string | null }) => invoke('downloads:update-settings', settings),
    readLinkList: filePath => invoke('downloads:read-link-list', { filePath }),
    importTorrent: input => invoke('downloads:import-torrent', input),
    copyLink: id => invoke('downloads:copy-link', { id }),
    openTask: (id, target) => invoke('downloads:open-task', { id, target }),
    executeCompletionAction: action => invoke('downloads:completion-action', { action }),
    onCompletionActionRequired: callback => subscribe('downloads:completion-action-required', callback),
    onUpdated: callback => subscribe('downloads:updated', callback),
  },
  magnets: {
    list: () => invoke('magnets:list'),
    inspect: (url, torrentPath = null) => invoke('magnets:inspect', { url, torrentPath }),
    inspectTask: id => invoke('magnets:inspect-task', { id }),
    add: input => invoke('magnets:add', input),
    updateSelection: (id, selectedFileIndices) => invoke('magnets:update-selection', { id, selectedFileIndices }),
    pause: id => invoke('magnets:pause', { id }),
    resume: id => invoke('magnets:resume', { id }),
    remove: (id, deleteFiles) => invoke('magnets:remove', { id, deleteFiles }),
    openFolder: id => invoke('magnets:open-folder', { id }),
    getSettings: () => invoke('magnets:settings'),
    updateSettings: (settings: Partial<MagnetSettings>) => invoke('magnets:update-settings', settings),
    onUpdated: callback => subscribe('magnets:updated', callback),
  },
  siteCollections: {
    list: () => invoke('site-collections:list'),
    create: (input: SiteCollectionInput) => invoke('site-collections:create', input),
    run: id => invoke('site-collections:run', { id }),
    stop: id => invoke('site-collections:stop', { id }),
    delete: id => invoke('site-collections:delete', { id }),
    addLinks: (id, links, queueName) => invoke('site-collections:add-links', { id, links, queueName }),
    onUpdated: callback => subscribe('site-collections:updated', callback),
  },
  system: {
    defaultDirectory: () => invoke('system:default-directory'),
    readClipboardText: () => invoke('system:read-clipboard'),
    registerProtocols: () => invoke('system:register-protocols'),
    installNativeHost: (browser, extensionId) => invoke('browser:install-native-host', { browser, extensionId }),
    openExtensionFolder: browser => invoke('browser:open-extension-folder', { browser }),
    onOpenLink: callback => subscribe('system:open-link', callback),
    onClipboardLink: callback => subscribe('system:clipboard-link', callback),
    takeTorrentPrompts: () => invoke('system:take-torrent-prompts'),
    onTorrentPromptAvailable: callback => subscribe('system:torrent-prompt-available', callback),
    chooseFile: request => invoke('system:choose-file', request),
    chooseDirectory: defaultPath => invoke('system:choose-directory', {
      kind: 'directory', ...(defaultPath === undefined ? {} : { defaultPath }),
    }),
    copyText: text => invoke('system:copy-text', { text }),
    capabilities: () => invoke('system:capabilities'),
    onEngineStatus: callback => subscribe('engine:status', callback),
    minimizeWindow: () => invoke('window:minimize'),
    toggleMaximizeWindow: () => invoke('window:toggle-maximize'),
    closeWindow: () => invoke('window:close'),
    isWindowMaximized: () => invoke('window:is-maximized'),
    onWindowMaximizedChanged: callback => subscribe('window:maximized-changed', callback),
  },
};

contextBridge.exposeInMainWorld('ldownload', api);
