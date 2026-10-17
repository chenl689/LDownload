import { useEffect, useMemo, useState } from 'react';
import type { DownloadSettings, EngineCapabilities } from '../shared/contracts';
import { TaskRow } from './TaskRow';
import type { DisplayTask } from './domain';
import { formatBytes, getTaskType } from './domain';

export type ViewName = '下载' | '已完成' | '链接收集' | '浏览器接管' | '设置';
type Props = {
  tasks: DisplayTask[];
  settings: DownloadSettings | null;
  capabilities: EngineCapabilities[];
  engineMessage: string;
  defaultDirectory: string;
  language: 'zh-CN' | 'en-US';
  view: ViewName;
  onView: (view: ViewName) => void;
  onCreate: (magnet: boolean) => void;
  onImport: () => void;
  onTheme: () => void;
  theme: 'light' | 'dark';
  onNotify: (message: string) => void;
  onPause: (task: DisplayTask) => void;
  onResume: (task: DisplayTask) => void;
  onRemove: (task: DisplayTask, deleteFiles?: boolean) => void;
  onMagnetFiles: (task: DisplayTask) => void;
  onCopy: (task: DisplayTask) => void;
  onOpenFile: (task: DisplayTask) => void;
  onOpenFolder: (task: DisplayTask) => void;
  onToggleAll: (taskIds: string[]) => void;
  windowMaximized: boolean;
  onWindowMinimize: () => void;
  onWindowToggleMaximize: () => void;
  onWindowClose: () => void;
};

const types = [
  ['video', '视频', 'Video'], ['installer', '安装包', 'Installer'], ['image', '图片', 'Image'],
  ['audio', '音频', 'Audio'], ['archive', '压缩包', 'Archives'], ['torrent', 'BT 种子', 'BitTorrent'],
  ['document', '文档', 'Documents'], ['other', '其他', 'Other'],
] as const;
const sortGroups = [
  { title: ['按创建时间', 'Created time'], options: [['created-desc', '从新到旧', 'Newest first'], ['created-asc', '从旧到新', 'Oldest first']] },
  { title: ['按当前进度', 'Current progress'], options: [['progress-asc', '从低到高', 'Low to high'], ['progress-desc', '从高到低', 'High to low']] },
  { title: ['按文件名称', 'File name'], options: [['name-asc', '从 A 到 Z', 'A to Z'], ['name-desc', '从 Z 到 A', 'Z to A']] },
  { title: ['按文件大小', 'File size'], options: [['size-asc', '从小到大', 'Smallest first'], ['size-desc', '从大到小', 'Largest first']] },
] as const;
function active(task: DisplayTask) { return ['downloading', 'merging', 'scanning'].includes(task.status); }

export function Dashboard(props: Props) {
  const { tasks, settings, engineMessage, defaultDirectory, language, view, onView } = props;
  const english = language === 'en-US';
  const tr = (zh: string, en: string) => english ? en : zh;
  const [filter, setFilter] = useState<'downloading' | 'completed'>(view === '已完成' ? 'completed' : 'downloading');
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('ldownload-sort-mode') || 'created-desc');
  const [typeFilter, setTypeFilter] = useState<Set<string> | null>(null);
  const [draftFilter, setDraftFilter] = useState<Set<string> | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(1);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [manualOrder, setManualOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ldownload-manual-order') || '[]');
      return Array.isArray(saved) ? saved.filter((id: unknown) => typeof id === 'string') : [];
    } catch { return []; }
  });
  const columns = settings?.visibleColumns || ['progress', 'size', 'speed', 'status'];
  const toolbar = settings?.toolbarButtons || ['theme', 'notifications', 'import', 'new-download'];
  const downloadingCount = tasks.filter(task => task.status !== 'completed').length;
  const completedCount = tasks.filter(task => task.status === 'completed').length;
  const running = tasks.some(active);
  const openToolbar = (key: string) => toolbar.includes(key);

  useEffect(() => {
    setFilter(view === '已完成' ? 'completed' : 'downloading');
    if (view === '下载' || view === '已完成') setPage(1);
  }, [view]);
  useEffect(() => {
    const ids = new Set(tasks.map(task => task.id));
    setManualOrder(current => {
      const next = current.filter(id => ids.has(id));
      ids.forEach(id => { if (!next.includes(id)) next.push(id); });
      return next;
    });
  }, [tasks]);
  useEffect(() => { localStorage.setItem('ldownload-manual-order', JSON.stringify(manualOrder)); }, [manualOrder]);
  useEffect(() => {
    if (!sortOpen && !filterOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('#sortButton, #sortPopover, #filterButton, #filterPopover')) return;
      setSortOpen(false);
      setFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSortOpen(false); setFilterOpen(false); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [sortOpen, filterOpen]);
  const orderedTasks = useMemo(() => {
    const list = [...tasks];
    const progress = (task: DisplayTask) => task.totalBytes ? task.downloadedBytes / task.totalBytes : 0;
    const compare: Record<string, (a: DisplayTask, b: DisplayTask) => number> = {
      'created-desc': (a, b) => b.createdAt - a.createdAt,
      'created-asc': (a, b) => a.createdAt - b.createdAt,
      'progress-asc': (a, b) => progress(a) - progress(b),
      'progress-desc': (a, b) => progress(b) - progress(a),
      'name-asc': (a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN'),
      'name-desc': (a, b) => b.fileName.localeCompare(a.fileName, 'zh-CN'),
      'size-asc': (a, b) => Number(a.totalBytes || 0) - Number(b.totalBytes || 0),
      'size-desc': (a, b) => Number(b.totalBytes || 0) - Number(a.totalBytes || 0),
    };
    if (sortMode === 'manual') {
      const order = new Map(manualOrder.map((id, index) => [id, index]));
      list.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    } else list.sort(compare[sortMode] || compare['created-desc']!);
    return list;
  }, [tasks, sortMode, manualOrder]);
  const sorted = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return orderedTasks.filter(task => {
      const statusMatch = filter === 'completed' ? task.status === 'completed' : task.status !== 'completed';
      const typeMatch = typeFilter === null || typeFilter.has(getTaskType(task));
      const text = [task.fileName, task.url, task.directory, task.error || ''].join(' ').toLocaleLowerCase();
      return statusMatch && typeMatch && (!needle || text.includes(needle));
    });
  }, [orderedTasks, query, filter, typeFilter]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / 10));
  useEffect(() => { setPage(current => Math.min(current, pageCount)); }, [pageCount]);
  const shown = sorted.slice((page - 1) * 10, page * 10);
  const pageList = Array.from({ length: pageCount }, (_, i) => i + 1).filter(value => value === 1 || value === pageCount || Math.abs(value - page) <= 1);
  const totalSpeed = tasks.filter(active).reduce((sum, task) => sum + Math.max(0, task.speedBytesSec), 0);
  const allPaused = tasks.filter(task => task.status !== 'completed').every(task => task.status === 'paused');
  const title = view === '已完成' ? tr('已完成', 'Completed') : view === '链接收集' ? tr('链接收集', 'Link collector') : view === '浏览器接管' ? tr('浏览器接管', 'Browser integration') : view === '设置' ? tr('设置', 'Settings') : tr('下载概览', 'Download overview');
  const today = new Intl.DateTimeFormat(english ? 'en-US' : 'zh-CN', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  const setSort = (value: string) => { setSortMode(value); localStorage.setItem('ldownload-sort-mode', value); };
  const setView = (value: ViewName) => { onView(value); setSidebarOpen(false); };
  const reorder = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    const visibleIds = sorted.map(task => task.id);
    const from = visibleIds.indexOf(sourceId);
    const to = visibleIds.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    visibleIds.splice(from, 1);
    visibleIds.splice(to, 0, sourceId);
    const visible = new Set(sorted.map(task => task.id));
    setManualOrder(current => {
      const order = current.length ? current.filter(id => tasks.some(task => task.id === id)) : tasks.map(task => task.id);
      tasks.forEach(task => { if (!order.includes(task.id)) order.push(task.id); });
      let nextVisible = 0;
      return order.map(id => visible.has(id) ? visibleIds[nextVisible++]! : id);
    });
    setSort('manual');
  };

  return (
    <div className="app">
      <aside className={'sidebar' + (sidebarOpen ? ' open' : '')} id="sidebar">
        <div className="brand"><img className="brand-mark" src="./app-icon.svg" alt="" /><div><div className="brand-name">LDownload</div><div className="brand-caption">Download, at your pace</div></div></div>
        <div className="nav-label">{tr('工作台', 'Workspace')}</div>
        <nav className="nav" aria-label={tr('主导航', 'Main navigation')}>
          <button className={'nav-item' + (view === '下载' ? ' active' : '')} onClick={() => setView('下载')}><svg><use href="#i-download" /></svg>{tr('下载', 'Downloads')}<span className="nav-count">{downloadingCount}</span></button>
          <button className={'nav-item' + (view === '已完成' ? ' active' : '')} onClick={() => setView('已完成')}><svg><use href="#i-check" /></svg>{tr('已完成', 'Completed')}</button>
        </nav>
        <div className="nav-label tools-nav-label">{tr('工具', 'Tools')}</div>
        <nav className="nav" aria-label={tr('工具', 'Tools')}>
          <button className={'nav-item' + (view === '链接收集' ? ' active' : '')} onClick={() => setView('链接收集')}><svg><use href="#i-globe" /></svg>{tr('链接收集', 'Link collector')}</button>
          <button className={'nav-item' + (view === '浏览器接管' ? ' active' : '')} onClick={() => setView('浏览器接管')}><svg><use href="#i-download" /></svg>{tr('浏览器接管', 'Browser integration')}</button>
          <button className={'nav-item' + (view === '设置' ? ' active' : '')} onClick={() => setView('设置')}><svg><use href="#i-settings" /></svg>{tr('设置', 'Settings')}</button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="storage"><div className="storage-head"><span>{tr('默认保存位置', 'Default download folder')}</span></div><div className="storage-note" id="defaultDirectory">{defaultDirectory || tr('正在读取系统下载目录…', 'Loading default download folder…')}</div></div>
        <div className="profile"><div className="avatar">LD</div><div className="profile-text"><strong>{tr('本机工作区', 'Local workspace')}</strong><span>{tr('所有数据保存在此设备', 'All data stays on this device')}</span></div></div>
      </aside>
      <main className="main download-view">
        <header className="topbar">
          <label className="search toolbar-search"><svg><use href="#i-search" /></svg><input id="searchInput" type="search" placeholder={tr('搜索文件名或网址', 'Search file name or URL')} aria-label={tr('搜索任务', 'Search downloads')} value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(1); }} /></label>
          <div className="topbar-right">
          <div className="top-actions">
            <button type="button" className="icon-btn mobile-menu" id="menuBtn" onClick={() => setSidebarOpen(value => !value)} aria-label={tr('打开导航', 'Open navigation')}><svg><use href="#i-menu" /></svg></button>
            {openToolbar('theme') && <button type="button" className="icon-btn" id="themeBtn" title={tr('切换主题', 'Switch theme')} onClick={props.onTheme}><svg><use href={document.documentElement.dataset.theme === 'dark' ? '#i-sun' : '#i-moon'} /></svg></button>}
            {openToolbar('notifications') && <button type="button" className="icon-btn" id="bellBtn" onClick={() => props.onNotify(tr('当前没有新通知。', 'No new notifications.'))}><svg><use href="#i-bell" /></svg></button>}
            {openToolbar('import') && <button type="button" className="secondary-btn" id="importList" onClick={props.onImport}>{tr('导入', 'Import')}</button>}
            {openToolbar('new-download') && <div className="new-task-menu-wrap" id="newTaskMenuWrap">
              <button type="button" className="add-btn" id="openModal" onClick={() => props.onCreate(false)}><svg><use href="#i-plus" /></svg>{tr('新建', 'New')}</button>
              <div className="new-task-popover" id="newTaskPopover" role="menu" aria-label={tr('新建任务', 'Create a task')}><button type="button" className="new-task-option" onClick={() => props.onCreate(false)}><span>{tr('新建链接任务', 'New link task')}</span><span className="new-task-shortcut"><kbd>Ctrl</kbd><kbd>N</kbd></span></button><button type="button" className="new-task-option" onClick={() => props.onCreate(true)}><span>{tr('新建 BT 任务', 'New torrent task')}</span></button></div>
            </div>}
          </div>
          <span className="window-controls-divider" aria-hidden="true" />
          <div className="window-controls" role="group" aria-label={tr('窗口控件', 'Window controls')}>
            <button type="button" className="window-control-btn" title={tr('最小化', 'Minimize')} aria-label={tr('最小化', 'Minimize')} onClick={props.onWindowMinimize}><svg><use href="#i-window-minimize" /></svg></button>
            <button type="button" className="window-control-btn" title={props.windowMaximized ? tr('还原', 'Restore') : tr('最大化', 'Maximize')} aria-label={props.windowMaximized ? tr('还原', 'Restore') : tr('最大化', 'Maximize')} onClick={props.onWindowToggleMaximize}><svg><use href={props.windowMaximized ? '#i-window-restore' : '#i-window-maximize'} /></svg></button>
            <button type="button" className="window-control-btn window-close-btn" title={tr('关闭', 'Close')} aria-label={tr('关闭', 'Close')} onClick={props.onWindowClose}><svg><use href="#i-window-close" /></svg></button>
          </div>
          </div>
        </header>
        <div className="content download-content">
          <section className="heading"><div><h1 id="pageTitle">{title}</h1><p className="subtitle">{tr('你的下载状态，一目了然。', 'Your downloads, at a glance.')}</p></div><div className="date-label">{today}</div></section>
          {engineMessage && <div className="engine-notice" id="engineNotice" role="status" aria-live="polite">{engineMessage}</div>}
          <section className="panel table-panel">
            <div className="tabs" role="tablist"><button type="button" className={'tab' + (filter === 'downloading' ? ' active' : '')} onClick={() => { setFilter('downloading'); onView('下载'); setPage(1); }}>{tr('下载中', 'Downloading')}<span>{downloadingCount}</span></button><button type="button" className={'tab' + (filter === 'completed' ? ' active' : '')} onClick={() => { setFilter('completed'); onView('已完成'); setPage(1); }}>{tr('已完成', 'Completed')}<span>{completedCount}</span></button></div>
            <div className="table-head">
              {downloadingCount > 0 && <div className={'download-summary' + (allPaused ? ' paused' : '')}><span className="download-summary-icon"><svg><use href="#i-download" /></svg></span><span className="download-summary-label">{allPaused ? tr('已暂停', 'Paused') : tr('当前总下载速度', 'Total download speed')}</span><strong className="download-summary-speed">{allPaused ? '' : formatBytes(totalSpeed, english) + '/s'}</strong></div>}
              <div className="table-tools"><button className="all-downloads-btn" id="toggleAllDownloads" type="button" disabled={!downloadingCount} onClick={() => props.onToggleAll(orderedTasks.filter(task => task.status !== 'completed').map(task => task.id))}><svg><use href={running ? '#i-pause' : '#i-download'} /></svg><span>{running ? tr('全部暂停', 'Pause all') : tr('全部开始', 'Start all')}</span></button>
<div className="tool-popover-anchor"><button className="icon-btn tool-icon-btn" id="sortButton" type="button" aria-label={tr('排序', 'Sort')} aria-expanded={sortOpen} onClick={() => { setSortOpen(value => !value); setFilterOpen(false); }}><svg><use href="#i-sort" /></svg></button>{sortOpen && <div className="tool-popover sort-popover" id="sortPopover" role="dialog"><h3>{tr('自定义排序', 'Custom sorting')}</h3><div className="sort-manual"><button type="button" className={'sort-option' + (sortMode === 'manual' ? ' active' : '')} onClick={() => setSort('manual')}>{tr('手动排序', 'Manual sort')}</button></div>{sortGroups.map(group => <section className="sort-group" key={group.title[0]}><div className="sort-group-title">{tr(group.title[0], group.title[1])}</div><div className="sort-options">{group.options.map(([mode, zh, en]) => <button type="button" key={mode} className={'sort-option' + (sortMode === mode ? ' active' : '')} onClick={() => setSort(mode)}>{tr(zh, en)}</button>)}</div></section>)}</div>}</div>
<div className="tool-popover-anchor"><button className={'icon-btn tool-icon-btn' + (typeFilter ? ' active' : '')} id="filterButton" type="button" aria-label={tr('筛选', 'Filter')} aria-expanded={filterOpen} onClick={() => { setDraftFilter(typeFilter ? new Set(typeFilter) : null); setFilterOpen(value => !value); setSortOpen(false); }}><svg><use href="#i-filter" /></svg></button>{filterOpen && <div className="tool-popover filter-popover" id="filterPopover" role="dialog"><div className="filter-popover-content"><h3>{tr('添加筛选条件', 'Add filters')}</h3><div className="filter-section"><div className="filter-section-title">{tr('文件类型', 'File type')}</div><label className="filter-check filter-all-check"><input type="checkbox" checked={draftFilter === null} onChange={() => setDraftFilter(null)} /><span>{tr('全部类型', 'All types')}</span></label><div className="filter-type-grid">{types.map(([key, zh, en]) => <label className="filter-check" key={key}><input type="checkbox" checked={draftFilter?.has(key) || false} onChange={event => { const checked = event.currentTarget.checked; setDraftFilter(current => { const next = new Set(current || []); if (checked) next.add(key); else next.delete(key); return next.size === types.length ? null : next; }); }} /><span>{tr(zh, en)}</span></label>)}</div></div></div><div className="filter-popover-actions"><button type="button" onClick={() => setDraftFilter(null)}>{tr('重置', 'Reset')}</button><div><button data-filter-action="cancel" type="button" onClick={() => setFilterOpen(false)}>{tr('取消', 'Cancel')}</button><button data-filter-action="confirm" type="button" onClick={() => { setTypeFilter(draftFilter); setFilterOpen(false); setPage(1); }}>{tr('确认', 'Apply')}</button></div></div></div>}</div>
              </div>
            </div>
            <div className="table-wrap"><table><thead aria-hidden="true"><tr><th data-column="progress" hidden={!columns.includes('progress')}>{tr('下载项目', 'Downloads')}</th><th data-column="size" hidden={!columns.includes('size')}>{tr('大小', 'Size')}</th><th data-column="speed" hidden={!columns.includes('speed')}>{tr('速度', 'Speed')}</th><th data-column="status" hidden={!columns.includes('status')}>{tr('状态', 'Status')}</th></tr></thead><tbody id="downloadRows">
              {!tasks.length ? <tr><td colSpan={7} className="empty-state"><span className="empty-icon"><svg><use href="#i-download" /></svg></span><strong>{tr('这里还没有下载', 'No downloads yet')}</strong><span>{tr('粘贴链接，或点击右上角“新建”开始。', 'Paste a link or click New to begin.')}</span></td></tr>
                : !shown.length ? <tr><td colSpan={7} className="empty-state">{tr('没有符合筛选条件的下载任务。', 'No downloads match these filters.')}</td></tr>
                  : shown.map(task => <TaskRow key={task.id} task={task} visibleColumns={columns} language={language}
                    onPause={props.onPause} onResume={props.onResume} onRemove={props.onRemove}
                    onMagnetFiles={props.onMagnetFiles} onCopy={props.onCopy}
                    onOpenFile={props.onOpenFile} onOpenFolder={props.onOpenFolder} onReorder={reorder} />)}
            </tbody></table></div>
            <div className="table-foot"><div className="pages" id="pages">{pageCount > 1 && <><button className="page-btn" disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>‹</button>{pageList.map((value, index) => <span key={value}>{index > 0 && value - pageList[index - 1]! > 1 ? <span aria-hidden="true">…</span> : null}<button className={'page-btn' + (value === page ? ' active' : '')} onClick={() => setPage(value)}>{value}</button></span>)}<button className="page-btn" disabled={page >= pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))}>›</button></>}</div></div>
          </section>
          <div className="footer-note"><span>{tr('任务和设置保存在本机 · 支持 HTTP / HTTPS / FTP / FTPS 与磁力下载', 'Tasks and settings stay on this device · HTTP / HTTPS / FTP / FTPS and magnets')}</span><span>{tr('快捷键', 'Shortcut')} <b>Ctrl + N</b> {tr('新建链接任务', 'new link task')}</span></div>
        </div>
      </main>
    </div>
  );
}
