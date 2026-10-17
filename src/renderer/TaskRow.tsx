import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DisplayTask } from './domain';
import { formatBytes } from './domain';

type Props = {
  task: DisplayTask;
  visibleColumns: string[];
  language: 'zh-CN' | 'en-US';
  onPause: (task: DisplayTask) => void;
  onResume: (task: DisplayTask) => void;
  onRemove: (task: DisplayTask, deleteFiles?: boolean) => void;
  onMagnetFiles: (task: DisplayTask) => void;
  onCopy: (task: DisplayTask) => void;
  onOpenFile: (task: DisplayTask) => void;
  onOpenFolder: (task: DisplayTask) => void;
  onReorder: (sourceId: string, targetId: string) => void;
};

type MenuPosition = { left: number; top: number };

function statusText(task: DisplayTask, english: boolean): string {
  const map: Record<string, string> = english
    ? { queued: 'Queued', downloading: 'Downloading', merging: 'Merging', scanning: 'Scanning', paused: 'Paused', completed: 'Completed', failed: 'Failed' }
    : { queued: '队列中', downloading: '进行中', merging: '合并中', scanning: '扫描中', paused: '已暂停', completed: '已完成', failed: '失败' };
  return map[task.status] || task.status;
}

function progressText(task: DisplayTask, english: boolean): string {
  if (task.kind === 'magnet') {
    if (task.status === 'paused') return english ? 'Paused' : '已暂停';
    if (task.status === 'queued') return english ? 'Queued' : '队列中';
    if (task.status === 'completed') return english ? 'Completed' : '已完成';
    if (task.status === 'failed') return task.error || (english ? 'Download failed' : '下载失败');
    const phases: Record<string, string> = english
      ? { finding_peers: 'Finding peers', metadata: 'Fetching metadata', waiting_metadata: 'Waiting for metadata · retrying', waiting_peers: 'Waiting for peers · retrying', waiting_engine: 'Waiting for Thunder engine', connecting: 'Connecting to peers', verifying: 'Verifying pieces', scanning: 'Scanning for viruses', downloading: 'Downloading' }
      : { finding_peers: '正在查找节点', metadata: '正在获取种子元数据', waiting_metadata: '等待元数据 · 自动重试中', waiting_peers: '等待可用节点 · 自动重试中', waiting_engine: '等待迅雷引擎空闲', connecting: '正在连接节点', verifying: '正在校验分片', scanning: '病毒扫描中', downloading: '正在下载' };
    return phases[task.phase || ''] || (english ? 'Downloading' : '正在下载');
  }
  if (task.status === 'merging') return english ? 'Merging ranges' : '正在合并分段';
  if (task.status === 'completed') return english ? (task.segments.length > 1 ? 'Ranges merged' : 'Saved') : (task.segments.length > 1 ? '分段已合并' : '已保存');
  if (task.status === 'paused') return english ? 'Paused' : '已暂停';
  if (task.status === 'queued') return english ? 'Waiting for a connection' : '等待可用连接';
  if (task.status === 'failed') return task.error || (english ? 'Download failed' : '下载失败');
  if (task.status === 'scanning') return english ? 'Scanning for viruses' : '病毒扫描中';
  return english ? 'Downloading' : '正在下载';
}

function segmentSummary(task: Extract<DisplayTask, { kind: 'ordinary' }>, english: boolean): string {
  const count = task.segments.length;
  const active = task.status === 'downloading' ? task.segments.filter(segment => segment.active).length : 0;
  if (task.status === 'merging') return english ? count + ' ranges complete · merging' : count + ' 个分段已完成 · 正在合并';
  if (task.status === 'completed') return english ? count + ' ranges · merged into one file' : count + ' 个分段 · 已合并为完整文件';
  return english ? count + ' ranges · ' + active + ' downloading' : count + ' 个分段 · ' + active + ' 个下载中';
}

export function TaskRow(props: Props) {
  const { task, visibleColumns, language } = props;
  const english = language === 'en-US';
  const tr = (zh: string, en: string) => english ? en : zh;
  const total = Number(task.totalBytes || 0);
  const downloaded = Number(task.downloadedBytes || 0);
  const percent = total > 0 ? Math.min(100, Math.floor(downloaded * 100 / total)) : 0;
  const running = ['downloading', 'merging', 'scanning'].includes(task.status);
  const statusClass = task.status === 'completed' ? 'done' : task.status === 'paused' ? 'paused' : task.status === 'queued' ? 'waiting' : task.status === 'failed' ? 'failed' : task.status === 'scanning' || task.status === 'merging' ? task.status : '';
  const parts = task.kind === 'ordinary' ? task.segments : [];
  const fileExtension = task.fileName.split('.').pop()?.toLowerCase() || '';
  const iconClass = ['zip', '7z', 'rar', 'tar', 'gz'].includes(fileExtension) ? 'zip' : fileExtension === 'pdf' ? 'pdf' : '';
  const speed = task.status === 'downloading' && task.speedBytesSec > 0 ? formatBytes(task.speedBytesSec, english) + '/s' : '—';
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const showContextMenu = (x: number, y: number) => {
    const width = 240;
    const height = task.kind === 'magnet' ? 205 : 165;
    setMenuPosition({
      left: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8)),
      top: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8)),
    });
  };

  useEffect(() => {
    if (!menuPosition) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuPosition(null);
    };
    const close = () => setMenuPosition(null);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuPosition]);

  const runMenuAction = (action: () => void) => {
    setMenuPosition(null);
    action();
  };
  const handleContextMenu = (event: React.MouseEvent<HTMLTableRowElement>) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY);
  };

  return <>
    <tr
      data-id={task.id}
      data-kind={task.kind}
      data-status={task.status}
      className={dragOver ? 'drag-over' : ''}
      draggable
      tabIndex={0}
      aria-label={task.fileName}
      onContextMenu={handleContextMenu}
      onDoubleClick={event => {
        if (event.target instanceof Element && event.target.closest('button')) return;
        if (task.status === 'completed') props.onOpenFile(task);
      }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          showContextMenu(rect.left + 24, rect.top + 24);
        }
      }}
      onDragStart={event => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', task.id);
        const card = event.currentTarget.querySelector('.download-entry');
        if (card) event.dataTransfer.setDragImage(card, Math.min(36, card.clientWidth / 2), Math.min(28, card.clientHeight / 2));
        event.currentTarget.classList.add('dragging');
      }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(true); }}
      onDragLeave={event => {
        const related = event.relatedTarget;
        if (!(related instanceof Node) || !event.currentTarget.contains(related)) setDragOver(false);
      }}
      onDrop={event => {
        event.preventDefault();
        props.onReorder(event.dataTransfer.getData('text/plain'), task.id);
        setDragOver(false);
      }}
      onDragEnd={event => { event.currentTarget.classList.remove('dragging'); setDragOver(false); }}
    >
      <td colSpan={7} className="entry-cell">
        <article className="download-entry">
          <div className={'file-icon ' + iconClass}><svg><use href="#i-file" /></svg></div>
          <div className="entry-main">
            <div className="file-info"><strong title={task.fileName}>{task.fileName}</strong></div>
            <div className="progress-cell" data-column="progress" hidden={!visibleColumns.includes('progress')}>
              <div className="progress-meta"><span title={progressText(task, english)}>{progressText(task, english)}</span><strong>{total ? percent + '%' : '—'}</strong></div>
              {parts.length > 1 ? <>
                <div className="segment-grid" aria-label={english ? 'Segment download progress' : '分段下载进度'}>
                  {parts.map((segment, index) => {
                    const size = Number(segment.totalBytes || 0);
                    const completed = Number(segment.downloadedBytes || 0);
                    const partPercent = size > 0 ? Math.min(100, Math.floor(completed * 100 / size)) : 0;
                    const state = partPercent === 100 ? (english ? 'complete' : '已完成') : segment.active && running ? (english ? 'downloading' : '下载中') : (english ? 'waiting' : '等待');
                    const title = (english ? 'Range ' : '分段 ') + (index + 1) + ': ' + formatBytes(completed, english) + ' / ' + formatBytes(size, english) + ' · ' + state;
                    return <span key={segment.index} title={title} aria-label={title} style={{ flexGrow: Math.max(1, size) / 1024 }}><i className={partPercent === 100 ? 'finished' : ''} style={{ width: partPercent + '%' }} /></span>;
                  })}
                </div>
                <small className="segment-summary">{segmentSummary(task as Extract<DisplayTask, { kind: 'ordinary' }>, english)}</small>
              </> : <div className="progress-bar"><span style={{ width: percent + '%', background: task.status === 'completed' ? 'var(--green)' : task.status === 'paused' ? 'var(--amber)' : task.status === 'failed' ? 'var(--red)' : undefined }} /></div>}
              <div className="entry-progress-foot">
                <small className="progress-bytes">{english ? 'Downloaded ' : '已下载 '}{formatBytes(downloaded, english)} / {total ? formatBytes(total) : (english ? 'calculating' : '计算中')}</small>
                <div className="entry-stats">
                  <span className="size-cell" data-column="size" hidden={!visibleColumns.includes('size')}>{formatBytes(task.totalBytes, english)}</span>
                  <span className="speed-cell" data-column="speed" hidden={!visibleColumns.includes('speed')}>{speed}</span>
                  <span className={'status ' + statusClass} data-column="status" hidden={!visibleColumns.includes('status')}>{statusText(task, english)}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="row-actions">
            {task.status !== 'completed' && (running
              ? <button type="button" className="row-btn pause-row" title={tr('暂停', 'Pause')} aria-label={tr('暂停任务', 'Pause download')} onClick={() => props.onPause(task)}><svg><use href="#i-pause" /></svg></button>
              : <button type="button" className="row-btn resume-row" title={tr('下载', 'Download')} aria-label={tr('下载或继续任务', 'Download or resume task')} onClick={() => props.onResume(task)}><svg><use href="#i-download" /></svg></button>)}
          </div>
        </article>
      </td>
    </tr>
    {menuPosition && createPortal(
      <div ref={menuRef} className="task-context-menu" role="menu" aria-label={tr('任务操作', 'Task actions')} style={menuPosition} onContextMenu={event => event.preventDefault()}>
        {task.kind === 'magnet' && <>
          <button type="button" role="menuitem" onClick={() => runMenuAction(() => props.onMagnetFiles(task))}>{tr('文件详情', 'File details')}</button>
          <hr />
        </>}
        <button type="button" role="menuitem" onClick={() => runMenuAction(() => props.onOpenFolder(task))}>{tr('打开所在文件夹', 'Open containing folder')}</button>
        <hr />
        <button type="button" role="menuitem" onClick={() => runMenuAction(() => props.onCopy(task))}>{tr('复制下载链接', 'Copy download link')}</button>
        <hr />
        <button type="button" role="menuitem" data-task-context-action="delete" onClick={() => runMenuAction(() => props.onRemove(task, false))}>{tr('从任务列表移除', 'Remove from task list')}</button>
        <button type="button" role="menuitem" data-task-context-action="delete-file" onClick={() => runMenuAction(() => props.onRemove(task, true))}>{tr('彻底删除文件和任务', 'Permanently delete files and task')}</button>
      </div>,
      document.body,
    )}
  </>;
}
