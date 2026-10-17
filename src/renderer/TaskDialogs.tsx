import { useEffect, useMemo, useState } from 'react';
import type { RendererApi } from '../shared/ipc';
import type { DisplayTask } from './domain';
import { formatBytes } from './domain';

type MagnetTask = Extract<DisplayTask, { kind: 'magnet' }>;
type MagnetFile = { index: number; path: string; size: number };
type Tab = 'selected' | 'all' | 'details';
type Props = {
  task: MagnetTask;
  api: RendererApi;
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  onNotify: (message: string) => void;
  onResume: (task: MagnetTask) => void;
  onSelectionSaved: () => void;
};

function fileCategory(path: string, english: boolean): string {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const groups: Array<[string, string[]]> = english
    ? [['Video', ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg']], ['Audio', ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg']], ['Image', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']], ['Archive', ['zip', 'rar', '7z', 'tar', 'gz']], ['Documents', ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt']]]
    : [['视频', ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg']], ['音频', ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg']], ['图片', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']], ['压缩包', ['zip', 'rar', '7z', 'tar', 'gz']], ['文档', ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt']]];
  return groups.find(([, extensions]) => extensions.includes(extension))?.[0] || (english ? 'Other files' : '其他文件');
}

function fileBadge(path: string): string {
  const extension = path.split('.').pop() || '';
  return extension.length > 4 ? extension.slice(0, 4).toUpperCase() : (extension || 'FILE').toUpperCase();
}

function sameSelection(left: number[], right: number[]): boolean {
  return left.length === right.length && [...left].sort((a, b) => a - b).every((value, index) => value === [...right].sort((a, b) => a - b)[index]);
}

function formatDate(value: number, english: boolean): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return new Intl.DateTimeFormat(english ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}

function formatDuration(milliseconds: number, english: boolean): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const time = [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  return days ? (english ? days + 'd ' : days + '天 ') + time : time;
}

export function TaskDialogs({ task, api, language, onClose, onNotify, onResume, onSelectionSaved }: Props) {
  const english = language === 'en-US';
  const tr = (zh: string, en: string) => english ? en : zh;
  const [files, setFiles] = useState<MagnetFile[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set(task.selectedFileIndices || []));
  const [savedSelection, setSavedSelection] = useState<number[]>(task.selectedFileIndices || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('selected');
  const [sourceView, setSourceView] = useState<'speed' | 'sources'>('speed');
  const [now, setNow] = useState(Date.now());

  const loadFiles = () => {
    setError('');
    setFiles(null);
    void api.magnets.inspectTask(task.sourceId)
      .then(preview => {
        setFiles(preview.files);
        const initial = task.selectedFileIndices || preview.files.map(file => file.index);
        setSelected(new Set(initial));
        setSavedSelection(initial);
      })
      .catch(cause => setError(String(cause)));
  };

  useEffect(() => { loadFiles(); }, [task.id, task.url, task.torrentFilePath]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedFiles = useMemo(() => files?.filter(file => selected.has(file.index)) || [], [files, selected]);
  const groupedSelected = useMemo(() => {
    const groups = new Map<string, MagnetFile[]>();
    for (const file of selectedFiles) {
      const category = fileCategory(file.path, english);
      groups.set(category, [...(groups.get(category) || []), file]);
    }
    return [...groups.entries()];
  }, [selectedFiles, english]);
  const sortedSelection = [...selected].sort((a, b) => a - b);
  const changed = !sameSelection(sortedSelection, savedSelection);
  const totalBytes = Number(task.totalBytes || 0);
  const downloadedBytes = Number(task.downloadedBytes || 0);
  const percent = totalBytes > 0 ? Math.min(100, Math.floor(downloadedBytes * 100 / totalBytes)) : 0;
  const canResume = ['paused', 'queued', 'failed'].includes(task.status);
  const toggleFile = (index: number, checked: boolean) => setSelected(current => {
    const next = new Set(current);
    if (checked) next.add(index);
    else next.delete(index);
    return next;
  });
  const toggleAll = (checked: boolean) => setSelected(checked ? new Set(files?.map(file => file.index) || []) : new Set());

  const saveSelection = async () => {
    if (!files || !selected.size || busy || !changed) return;
    setBusy(true);
    setError('');
    try {
      await api.magnets.updateSelection(task.sourceId, sortedSelection);
      setSavedSelection(sortedSelection);
      onNotify(tr('磁力文件选择已保存，正在启动下载。', 'File selection saved; starting download.'));
      onSelectionSaved();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };

  const copyLink = async () => {
    try {
      await api.system.copyText(task.url);
      onNotify(tr('下载链接已复制。', 'Download link copied.'));
    } catch (cause) { onNotify(tr('复制链接失败：', 'Could not copy link: ') + String(cause)); }
  };

  const openFolder = async () => {
    try { await api.magnets.openFolder(task.sourceId); }
    catch (cause) { onNotify(tr('打开目录失败：', 'Could not open folder: ') + String(cause)); }
  };

  const tabButton = (value: Tab, zh: string, en: string) => (
    <button type="button" role="tab" aria-selected={tab === value} className={'detail-tab' + (tab === value ? ' active' : '')} onClick={() => setTab(value)}>{tr(zh, en)}</button>
  );

  return (
    <div className="modal-backdrop open task-detail-backdrop" role="dialog" aria-modal="true" aria-labelledby="taskDialogTitle" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal task-detail-modal" aria-label={tr('磁力任务文件详情', 'Magnet task file details')}>
        <header className="task-detail-header">
          <div className="task-detail-title"><h2 id="taskDialogTitle" title={task.fileName}>{task.fileName}</h2><p>{formatBytes(totalBytes, english)}{files ? ' · ' + files.length + ' ' + tr('个文件', 'files') : ''}</p></div>
          <button type="button" className="close-btn" onClick={onClose} aria-label={tr('关闭', 'Close')}><svg><use href="#i-close" /></svg></button>
        </header>
        <nav className="detail-tabs" role="tablist" aria-label={tr('文件详情页签', 'File detail tabs')}>
          {tabButton('selected', '已选文件', 'Selected files')}
          {tabButton('all', '全部文件', 'All files')}
          {tabButton('details', '详细信息', 'Details')}
        </nav>
        <main className="task-detail-content">
          {tab === 'selected' && <>
            <div className="detail-list-summary">{files ? tr('已添加 ', 'Added ') + selected.size + '/' + files.length + tr(' 个文件', ' files') : tr('正在读取文件清单…', 'Reading file list…')}</div>
            {error && <div className="detail-error" role="alert">{error}<button type="button" onClick={loadFiles}>{tr('重试', 'Retry')}</button></div>}
            {files && !selectedFiles.length && <div className="detail-empty">{tr('尚未选择任何文件，请到“全部文件”中选择。', 'No files selected. Choose files in All files.')}</div>}
            {groupedSelected.map(([category, items]) => <section className="selected-file-group" key={category}><h3>{category}</h3><div className="selected-file-grid">{items.map(file => <label className="selected-file-card" key={file.index} title={file.path}><input type="checkbox" checked={selected.has(file.index)} onChange={event => { const checked = event.currentTarget.checked; toggleFile(file.index, checked); }} /><span className="file-type-badge">{fileBadge(file.path)}</span><span className="selected-file-name">{file.path.split(/[\\/]/).pop() || file.path}</span><span className="selected-file-size">{formatBytes(file.size, english)}</span></label>)}</div></section>)}
          </>}
          {tab === 'all' && <>
            <div className="detail-table-head"><span>{tr('文件名', 'File name')}</span><span>{tr('大小', 'Size')}</span></div>
            {error && <div className="detail-error" role="alert">{error}<button type="button" onClick={loadFiles}>{tr('重试', 'Retry')}</button></div>}
            {files ? <div className="all-file-list">{files.map(file => <label className={'all-file-row' + (selected.has(file.index) ? ' selected' : '')} key={file.index}><input type="checkbox" checked={selected.has(file.index)} onChange={event => { const checked = event.currentTarget.checked; toggleFile(file.index, checked); }} /><span className="file-type-badge">{fileBadge(file.path)}</span><span className="all-file-name" title={file.path}>{file.path}</span><span className="all-file-size">{formatBytes(file.size, english)}</span></label>)}</div> : !error && <div className="detail-empty">{tr('正在读取文件清单…', 'Reading file list…')}</div>}
          </>}
          {tab === 'details' && <div className="task-magnet-overview">
            <section className="magnet-progress-card">
              <div className="progress-card-toggle"><button type="button" className={sourceView === 'speed' ? 'active' : ''} onClick={() => setSourceView('speed')}>{tr('速度', 'Speed')}</button><button type="button" className={sourceView === 'sources' ? 'active' : ''} onClick={() => setSourceView('sources')}>{tr('来源', 'Sources')}</button></div>
              {sourceView === 'speed' ? <div className="progress-card-main"><strong>{task.speedBytesSec > 0 ? formatBytes(task.speedBytesSec, english) + '/s' : '0 B/s'}</strong><span>{tr('当前下载速度', 'Current download speed')}</span></div> : <div className="source-stat-grid"><div><strong>{task.livePeers}</strong><span>{tr('连接节点', 'Connected peers')}</span></div><div><strong>{task.dhtNodes}</strong><span>DHT</span></div><div><strong>{task.diagnostics.discoveredPeers}</strong><span>{tr('已发现节点', 'Discovered peers')}</span></div></div>}
              {canResume && <button type="button" className="resume-magnet-btn" onClick={() => onResume(task)}><svg><use href="#i-download" /></svg>{tr('继续下载', 'Resume download')}</button>}
              <div className="progress-card-footer"><span>{tr('下载进度', 'Progress')}</span><strong>{totalBytes > 0 ? percent + '%' : tr('检测中', 'Checking')}</strong></div>
              <div className="magnet-progress-track"><span style={{ width: percent + '%' }} /></div>
              {totalBytes > 0 && <div className="progress-card-footnote">{formatBytes(downloadedBytes, english)} / {formatBytes(totalBytes, english)}</div>}
            </section>
            <dl className="task-detail-info">
              <div><dt>{tr('下载链接', 'Download link')}</dt><dd className="detail-link-value" title={task.url}>{task.url}</dd><button type="button" className="detail-inline-action" onClick={() => void copyLink()}>{tr('复制链接', 'Copy link')}</button></div>
              <div><dt>{tr('保存目录', 'Save directory')}</dt><dd title={task.directory}>{task.directory}</dd><button type="button" className="detail-inline-action" onClick={() => void openFolder()}>{tr('打开目录', 'Open folder')}</button></div>
              <div><dt>{tr('创建时间', 'Created')}</dt><dd>{formatDate(task.createdAt, english)}</dd></div>
              <div><dt>{tr('任务时长', 'Task duration')}</dt><dd>{formatDuration(now - task.createdAt, english)}</dd></div>
              <div><dt>{tr('已下载', 'Downloaded')}</dt><dd>{formatBytes(downloadedBytes, english)}</dd></div>
            </dl>
          </div>}
        </main>
        {tab !== 'details' && <footer className="task-detail-footer">
          <label className="detail-select-all"><input type="checkbox" checked={Boolean(files?.length) && selected.size === files?.length} disabled={!files} onChange={event => toggleAll(event.currentTarget.checked)} /><span>{tr('全选', 'Select all')}</span><span className="detail-selected-count">{tr('已选 ', 'Selected ') + selected.size + tr(' 项', '')}</span></label>
<button type="button" className="add-btn" disabled={!files || !selected.size || busy || !changed} onClick={() => void saveSelection()}>{busy ? tr('保存中…', 'Saving…') : tr('保存选择', 'Save selection')}</button>
        </footer>}
      </section>
    </div>
  );
}
