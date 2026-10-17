import { useEffect, useMemo, useRef, useState } from 'react';
import type { DownloadSettings, EngineCapabilities, MagnetSettings } from '../shared/contracts';
import type { RendererApi } from '../shared/ipc';
import { BrowserDialog, CollectionDialog } from './AuxiliaryDialogs';
import { Dashboard, type ViewName } from './Dashboard';
import { DownloadDialog } from './DownloadDialog';
import { combineTasks, type DisplayTask } from './domain';
import { SettingsDialog } from './SettingsDialog';
import { TaskDialogs } from './TaskDialogs';

const api: RendererApi = window.ldownload;

type RemoveState = { tasks: DisplayTask[]; deleteFiles: boolean } | null;

export function App() {
  const [downloads, setDownloads] = useState<Awaited<ReturnType<RendererApi['downloads']['list']>>>([]);
  const [magnets, setMagnets] = useState<Awaited<ReturnType<RendererApi['magnets']['list']>>>([]);
  const [settings, setSettings] = useState<DownloadSettings | null>(null);
  const [magnetSettings, setMagnetSettings] = useState<MagnetSettings | null>(null);
  const [capabilities, setCapabilities] = useState<EngineCapabilities[]>([]);
  const [defaultDirectory, setDefaultDirectory] = useState('');
  const [engineMessage, setEngineMessage] = useState('');
  const [language, setLanguage] = useState<'zh-CN' | 'en-US'>('zh-CN');
  const languageRef = useRef<'zh-CN' | 'en-US'>('zh-CN');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('ldownload-theme') === 'dark' ? 'dark' : 'light');
  const [view, setView] = useState<ViewName>('下载');
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadInitial, setDownloadInitial] = useState('');
  const [torrentInitial, setTorrentInitial] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [taskDetails, setTaskDetails] = useState<Extract<DisplayTask, { kind: 'magnet' }> | null>(null);
  const [removeState, setRemoveState] = useState<RemoveState>(null);
  const [notice, setNotice] = useState('');
  const [clipboardLink, setClipboardLink] = useState<string | null>(null);
  const [completionActionRequired, setCompletionActionRequired] = useState<'exit' | 'shutdown' | null>(null);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const dialogRequestRef = useRef(0);
  const downloadDialogOpenRef = useRef(false);
  const pendingTorrentPathsRef = useRef<string[]>([]);

  const tasks = useMemo(() => combineTasks(downloads, magnets), [downloads, magnets]);
  const currentTaskDetails = taskDetails ? tasks.find((task): task is Extract<DisplayTask, { kind: 'magnet' }> => task.kind === 'magnet' && task.sourceId === taskDetails.sourceId) || taskDetails : null;
  const tr = (zh: string, en: string) => language === 'en-US' ? en : zh;
  const queues = settings?.queues || [{ name: '默认', paused: false }];
  const notify = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(current => current === message ? '' : current), 4500);
  };
  const refreshTasks = async () => {
    const [nextDownloads, nextMagnets] = await Promise.all([api.downloads.list(), api.magnets.list()]);
    setDownloads(nextDownloads);
    setMagnets(nextMagnets);
  };
  const openDownload = (value = '', torrentPath: string | null = null) => {
    setDownloadInitial(value);
    setTorrentInitial(torrentPath);
    downloadDialogOpenRef.current = true;
    setDownloadOpen(true);
  };
  const showNextTorrentPrompt = () => {
    if (downloadDialogOpenRef.current || pendingTorrentPathsRef.current.length === 0) return;
    const torrentPath = pendingTorrentPathsRef.current.shift()!;
    setDownloadInitial('');
    setTorrentInitial(torrentPath);
    downloadDialogOpenRef.current = true;
    setDownloadOpen(true);
  };
  const enqueueTorrentPrompts = (paths: string[]) => {
    pendingTorrentPathsRef.current.push(...paths);
    showNextTorrentPrompt();
  };
  const closeDownload = () => {
    downloadDialogOpenRef.current = false;
    setDownloadOpen(false);
    setTorrentInitial(null);
    // Let the current dialog finish closing before mounting the next queued
    // torrent preview, so each downloaded seed gets an explicit confirmation.
    window.setTimeout(showNextTorrentPrompt, 0);
  };
  const openNewTask = async (torrent: boolean) => {
    if (!torrent) { openDownload(); return; }
    try {
      const path = await api.system.chooseFile({ kind: 'torrent' });
      if (path) openDownload('', path);
    } catch (error) { notify(tr('打开种子文件失败：', 'Could not open torrent file picker: ') + String(error)); }
  };
  const showView = (next: ViewName) => {
    const requestId = ++dialogRequestRef.current;
    setView(next);
    setSettingsOpen(false);
    setCollectionOpen(false);
    setBrowserOpen(false);
    if (next === '设置') {
      void Promise.all([api.downloads.getSettings(), api.magnets.getSettings()]).then(([downloadSettings, nextMagnetSettings]) => {
        if (requestId !== dialogRequestRef.current) return;
        setSettings(downloadSettings);
        setMagnetSettings(nextMagnetSettings);
        setLanguage(downloadSettings.language);
        languageRef.current = downloadSettings.language;
        if (downloadSettings.defaultDownloadDirectory) setDefaultDirectory(downloadSettings.defaultDownloadDirectory);
        setSettingsOpen(true);
      }).catch(error => {
        if (requestId !== dialogRequestRef.current) return;
        notify(tr('读取下载设置失败：', 'Could not load download settings: ') + String(error));
        setSettingsOpen(true);
      });
    }
    if (next === '链接收集') setCollectionOpen(true);
    if (next === '浏览器接管') setBrowserOpen(true);
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      api.downloads.list(), api.magnets.list(), api.downloads.getSettings(), api.magnets.getSettings(),
      api.system.defaultDirectory(), api.system.capabilities(),
    ]).then(results => {
      if (cancelled) return;
      const [downloadResult, magnetResult, settingsResult, magnetSettingsResult, directoryResult, capabilityResult] = results;
      if (downloadResult.status === 'fulfilled') setDownloads(downloadResult.value);
      if (magnetResult.status === 'fulfilled') setMagnets(magnetResult.value);
      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value);
        setLanguage(settingsResult.value.language);
        languageRef.current = settingsResult.value.language;
        if (settingsResult.value.defaultDownloadDirectory) setDefaultDirectory(settingsResult.value.defaultDownloadDirectory);
      } else notify(tr('读取下载设置失败：', 'Could not load download settings: ') + String(settingsResult.reason));
      if (magnetSettingsResult.status === 'fulfilled') setMagnetSettings(magnetSettingsResult.value);
      if (directoryResult.status === 'fulfilled') setDefaultDirectory(current => current || directoryResult.value);
      if (capabilityResult.status === 'fulfilled') {
        setCapabilities(capabilityResult.value);
        const thunder = capabilityResult.value.find(item => item.id === 'thunder-sdk');
        const english = settingsResult.status === 'fulfilled' ? settingsResult.value.language === 'en-US' : languageRef.current === 'en-US';
        setEngineMessage(thunder?.available ? '' : (english ? 'Thunder SDK unavailable: ' : '迅雷 SDK 未就绪：') + (thunder?.reason || (english ? 'Bundled SDK copy was not found' : '未检测到安装包内副本')));
      }
    });
    const offDownloads = api.downloads.onUpdated(setDownloads);
    const offMagnets = api.magnets.onUpdated(setMagnets);
    const offStatus = api.system.onEngineStatus(status => {
      const english = languageRef.current === 'en-US';
      setEngineMessage(status.state === 'failed' ? (english ? 'Download engine failed to start' : '下载引擎启动失败') + (status.message ? ': ' + status.message : '') : '');
    });
    const offLink = api.system.onOpenLink(payload => openDownload(payload.url));
    const offClipboard = api.system.onClipboardLink(payload => setClipboardLink(payload.url));
    const offTorrentPrompt = api.system.onTorrentPromptAvailable(() => {
      void api.system.takeTorrentPrompts().then(enqueueTorrentPrompts).catch(error => notify(tr('读取待确认的种子文件失败：', 'Could not read pending torrent prompts: ') + String(error)));
    });
    void api.system.takeTorrentPrompts().then(enqueueTorrentPrompts).catch(error => notify(tr('读取待确认的种子文件失败：', 'Could not read pending torrent prompts: ') + String(error)));
    const offCompletionAction = api.downloads.onCompletionActionRequired(payload => setCompletionActionRequired(payload.action));
    const offWindowMaximized = api.system.onWindowMaximizedChanged(setWindowMaximized);
    void api.system.isWindowMaximized().then(setWindowMaximized).catch(() => undefined);
    return () => {
      cancelled = true;
      offDownloads(); offMagnets(); offStatus(); offLink(); offClipboard(); offTorrentPrompt(); offCompletionAction(); offWindowMaximized();
    };
  }, []);


  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault(); openDownload();
      }
      if (event.key === 'Escape') {
        if (downloadOpen) closeDownload();
        else if (settingsOpen) setSettingsOpen(false);
        else if (collectionOpen) setCollectionOpen(false);
        else if (browserOpen) setBrowserOpen(false);
        else if (taskDetails) setTaskDetails(null);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [downloadOpen, settingsOpen, collectionOpen, browserOpen, taskDetails]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ldownload-theme', theme);
  }, [theme]);

  const pause = async (task: DisplayTask) => {
    try { task.kind === 'magnet' ? await api.magnets.pause(task.sourceId) : await api.downloads.pause(task.id); }
    catch (error) { notify(tr('暂停任务失败：', 'Could not pause task: ') + String(error)); }
  };
  const resume = async (task: DisplayTask) => {
    try { task.kind === 'magnet' ? await api.magnets.resume(task.sourceId) : await api.downloads.resume(task.id); }
    catch (error) { notify(tr('启动任务失败：', 'Could not start task: ') + String(error)); }
  };
  const toggleAll = async (taskIds: string[]) => {
    const pending = tasks.filter(task => task.status !== 'completed');
    try {
      if (pending.some(task => ['downloading', 'merging', 'scanning'].includes(task.status))) {
        await api.downloads.pauseAll(taskIds);
      } else await api.downloads.startAll(taskIds);
    } catch (error) { notify(tr('批量操作失败：', 'Bulk operation failed: ') + String(error)); }
  };
  const removeTasks = async (deleteFiles: boolean) => {
    const targets = removeState?.tasks || [];
    setRemoveState(null);
    for (const task of targets) {
      try {
        if (task.kind === 'magnet') await api.magnets.remove(task.sourceId, deleteFiles);
        else await api.downloads.remove(task.id, deleteFiles);
      } catch (error) { notify(tr('删除任务失败：', 'Could not remove task: ') + String(error)); }
    }
  };
  const importList = async () => {
    try {
      const path = await api.system.chooseFile({ kind: 'link-list' });
      if (!path) return;
      const links = await api.downloads.readLinkList(path);
      if (links.length) openDownload(links.join('\n'));
      else notify(tr('文件中没有可导入的链接。', 'The file contains no importable links.'));
    } catch (error) { notify(tr('导入链接列表失败：', 'Could not import link list: ') + String(error)); }
  };
  const copyLink = async (task: DisplayTask) => {
    try { await api.system.copyText(task.url); notify(tr('下载链接已复制。', 'Download link copied.')); }
    catch (error) { notify(tr('复制链接失败：', 'Could not copy link: ') + String(error)); }
  };
  const openTaskFile = async (task: DisplayTask) => {
    if (task.status !== 'completed') return;
    try {
      if (task.kind === 'magnet') await api.magnets.openFolder(task.sourceId);
      else await api.downloads.openTask(task.id, 'file');
    } catch (error) { notify(tr('打开文件失败：', 'Could not open file: ') + String(error)); }
  };
  const openTaskFolder = async (task: DisplayTask) => {
    try {
      if (task.kind === 'magnet') await api.magnets.openFolder(task.sourceId);
      else await api.downloads.openTask(task.id, 'folder');
    } catch (error) { notify(tr('打开所在文件夹失败：', 'Could not open containing folder: ') + String(error)); }
  };
  const addCollectedLinks = async (links: string[], queueName: string) => {
    for (const link of links) await api.downloads.add({ url: link, queueName, directory: defaultDirectory });
    await refreshTasks();
    notify(tr('已将链接加入下载队列。', 'Links added to the download queue.'));
  };
  const confirmCompletionAction = async () => {
    const action = completionActionRequired;
    if (!action) return;
    setCompletionActionRequired(null);
    try { await api.downloads.executeCompletionAction(action); }
    catch (error) { notify(tr('执行完成后操作失败：', 'Could not perform the post-download action: ') + String(error)); }
  };
  const savedSettings = (next: DownloadSettings, nextMagnet: MagnetSettings) => {
    setSettings(next); setMagnetSettings(nextMagnet); setLanguage(next.language); languageRef.current = next.language;
    if (next.defaultDownloadDirectory) setDefaultDirectory(next.defaultDownloadDirectory);
  };

  return <>
    {clipboardLink && <div className="clipboard-prompt" role="status" aria-live="polite"><span>{tr('发现剪贴板中的下载链接：', 'Download link found on the clipboard: ')}<code title={clipboardLink}>{clipboardLink}</code></span><button type="button" onClick={() => setClipboardLink(null)}>{tr('忽略', 'Dismiss')}</button><button type="button" onClick={() => { const url = clipboardLink; setClipboardLink(null); openDownload(url); }}>{tr('添加任务', 'Add task')}</button></div>}
    <Dashboard tasks={tasks} settings={settings} capabilities={capabilities} engineMessage={engineMessage} defaultDirectory={defaultDirectory} language={language} view={view} onView={showView}
      onCreate={openNewTask} onImport={() => void importList()} onTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} theme={theme} onNotify={notify}
      onPause={task => void pause(task)} onResume={task => void resume(task)}
      onRemove={(task, deleteFiles = false) => setRemoveState({ tasks: [task], deleteFiles })}
      onMagnetFiles={task => { if (task.kind === 'magnet') setTaskDetails(task); }} onCopy={task => void copyLink(task)}
      onOpenFile={task => void openTaskFile(task)} onOpenFolder={task => void openTaskFolder(task)}
      onToggleAll={taskIds => void toggleAll(taskIds)}
      windowMaximized={windowMaximized} onWindowMinimize={() => void api.system.minimizeWindow()}
      onWindowToggleMaximize={() => void api.system.toggleMaximizeWindow()} onWindowClose={() => void api.system.closeWindow()} />
    <DownloadDialog open={downloadOpen} api={api} queues={queues} defaultDirectory={defaultDirectory} magnetRetryDelaySeconds={magnetSettings?.magnetRetryDelaySeconds || 10} language={language} initialValue={downloadInitial} initialTorrentPath={torrentInitial}
      onClose={closeDownload} onNotify={notify} onCreated={() => void refreshTasks()} />
    <SettingsDialog open={settingsOpen} settings={settings} magnetSettings={magnetSettings} api={api} language={language} onClose={() => { ++dialogRequestRef.current; setSettingsOpen(false); if (view === '设置') setView('下载'); }} onSaved={savedSettings} onNotify={notify} />
    <CollectionDialog open={collectionOpen} api={api} queues={queues} language={language} onClose={() => { ++dialogRequestRef.current; setCollectionOpen(false); if (view === '链接收集') setView('下载'); }} onNotify={notify} onAddLinks={addCollectedLinks} />
    <BrowserDialog open={browserOpen} api={api} language={language} onClose={() => { ++dialogRequestRef.current; setBrowserOpen(false); if (view === '浏览器接管') setView('下载'); }} onNotify={notify} />
{currentTaskDetails?.kind === 'magnet' && <TaskDialogs task={currentTaskDetails} api={api} language={language} onClose={() => setTaskDetails(null)} onNotify={notify} onResume={task => void resume(task)} onSelectionSaved={() => { void refreshTasks(); setTaskDetails(null); }} />}
    {completionActionRequired && <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="completionActionTitle"><section className="modal settings-modal remove-confirm-modal"><div className="modal-head"><div><h2 id="completionActionTitle">{completionActionRequired === 'exit' ? tr('所有下载已完成，退出 LDownload？', 'All downloads are complete. Exit LDownload?') : tr('所有下载已完成，关闭电脑？', 'All downloads are complete. Shut down the computer?')}</h2><p>{tr('请确认是否执行设置的完成后操作。', 'Confirm whether to perform the configured post-download action.')}</p></div></div><div className="modal-actions"><button type="button" className="secondary-btn" onClick={() => setCompletionActionRequired(null)}>{tr('取消', 'Cancel')}</button><button type="button" className="add-btn" onClick={() => void confirmCompletionAction()}>{completionActionRequired === 'exit' ? tr('退出应用', 'Exit app') : tr('关机', 'Shut down')}</button></div></section></div>}
    {removeState && <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="removeTitle" onMouseDown={event => { if (event.target === event.currentTarget) setRemoveState(null); }}><section className="modal settings-modal remove-confirm-modal"><div className="modal-head"><div><h2 id="removeTitle">{removeState.deleteFiles ? tr('彻底删除磁盘文件和任务？', 'Permanently delete downloaded files and task?') : tr('从任务列表移除？', 'Remove from the task list?')}</h2><p>{removeState.deleteFiles ? tr('此操作会删除已下载的磁盘文件，无法恢复。', 'Downloaded files will be deleted and cannot be recovered.') : tr('只移除任务记录，已下载文件会保留。', 'Only the task record will be removed; downloaded files will stay.')}</p></div><button type="button" className="close-btn" onClick={() => setRemoveState(null)} aria-label={tr('关闭', 'Close')}><svg><use href="#i-close" /></svg></button></div><div className="modal-actions"><button type="button" className="secondary-btn" onClick={() => setRemoveState(null)}>{tr('取消', 'Cancel')}</button><button type="button" className={removeState.deleteFiles ? 'danger-btn' : 'add-btn'} onClick={() => void removeTasks(removeState.deleteFiles)}>{removeState.deleteFiles ? tr('彻底删除', 'Delete permanently') : tr('移除任务', 'Remove task')}</button></div></section></div>}
    {notice && <div className="toast-notice" role="status" aria-live="polite">{notice}</div>}
  </>;
}
