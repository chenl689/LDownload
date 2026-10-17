import { useEffect, useState } from 'react';
import type { AddDownloadInput, DownloadMetadata, DownloadQueue, MagnetFilePreview } from '../shared/contracts';
import { downloadSourceIdentity } from '../shared/download-identity';
import type { RendererApi } from '../shared/ipc';
import { formatBytes, isMagnet, isSupportedLink, parseLinks } from './domain';

type Props = {
  open: boolean;
  api: RendererApi;
  queues: DownloadQueue[];
  defaultDirectory: string;
  magnetRetryDelaySeconds: number;
  language: 'zh-CN' | 'en-US';
  initialValue: string;
  initialTorrentPath: string | null;
  onClose: () => void;
  onNotify: (message: string) => void;
  onCreated: () => void;
};

export function DownloadDialog(props: Props) {
  const { open, api, queues, defaultDirectory, magnetRetryDelaySeconds, language, initialValue, initialTorrentPath, onClose, onNotify, onCreated } = props;
  const english = language === 'en-US';
  const tr = (zh: string, en: string) => english ? en : zh;
  const [urlText, setUrlText] = useState(initialValue);
  const [torrentPath, setTorrentPath] = useState<string | null>(initialTorrentPath);
  const [fileName, setFileName] = useState('');
  const [directory, setDirectory] = useState(defaultDirectory);
  const [category, setCategory] = useState('auto');
  const [queueName, setQueueName] = useState(queues[0]?.name || '默认');
  const [speedLimit, setSpeedLimit] = useState('0');
  const [authScheme, setAuthScheme] = useState<'basic' | 'bearer'>('basic');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [allowInsecureAuth, setAllowInsecureAuth] = useState(false);
  const [referer, setReferer] = useState('');
  const [userAgent, setUserAgent] = useState('');
  const [cookie, setCookie] = useState('');
  const [checksumAlgorithm, setChecksumAlgorithm] = useState('sha256');
  const [checksum, setChecksum] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [repeat, setRepeat] = useState('none');
  const [preview, setPreview] = useState<MagnetFilePreview | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [ordinaryMetadata, setOrdinaryMetadata] = useState<DownloadMetadata | null>(null);
  const [inspectionMessage, setInspectionMessage] = useState('');
  const [inspectionError, setInspectionError] = useState('');
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [clockNow, setClockNow] = useState(Date.now());
  const [retryCount, setRetryCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  useEffect(() => {
    if (!open) return;
    setUrlText(initialValue);
    setTorrentPath(initialTorrentPath);
    setFileName('');
    setDirectory(defaultDirectory);
    setCategory('auto');
    setQueueName(queues[0]?.name || '默认');
    setSpeedLimit('0');
    setAuthScheme('basic');
    setAuthUsername('');
    setAuthPassword('');
    setAllowInsecureAuth(false);
    setReferer('');
    setUserAgent('');
    setCookie('');
    setChecksum('');
    setScheduledAt('');
    setRepeat('none');
    setPreview(null);
    setSelectedFiles(new Set());
    setOrdinaryMetadata(null);
    setInspectionMessage('');
    setInspectionError('');
    setDialogError('');
    setInspectionLoading(false);
    setRetryAt(0);
    setClockNow(Date.now());
    setRetryCount(0);
  }, [open, initialValue, initialTorrentPath, defaultDirectory]);

  const links = parseLinks(urlText);
  const magnets = links.filter(isMagnet);
  const singleMagnet = magnets.length === 1 && links.length === 1 && !torrentPath;
  const needsMagnetMetadata = Boolean(torrentPath) || magnets.length > 0;

  useEffect(() => {
    if (!open) return;
    if (!needsMagnetMetadata || (!torrentPath && (links.length !== 1 || magnets.length !== 1))) {
      setPreview(null);
      setSelectedFiles(new Set());
      setOrdinaryMetadata(null);
      setInspectionLoading(false);
      setInspectionError('');
      setInspectionMessage('');
      return;
    }
    let cancelled = false;
    const target = torrentPath ? 'torrent:' + torrentPath : 'magnet:' + links[0];
    const startedAt = Date.now();
    setRetryAt(startedAt + Math.max(1, magnetRetryDelaySeconds) * 1000);
    setInspectionLoading(true);
    setInspectionError('');
    setInspectionMessage(tr('正在解析磁力并获取文件列表…', 'Resolving magnet metadata and file list…'));
    const timeout = setTimeout(() => {
      const work = torrentPath
        ? api.magnets.inspect('', torrentPath)
        : api.magnets.inspect(links[0] || '', null);
      void work.then(result => {
        if (cancelled) return;
        setPreview(result);
        setSelectedFiles(new Set(result.files.map(file => file.index)));
        setFileName(current => current || result.name);
        setInspectionMessage(result.name + ' · ' + result.files.length + tr(' 个文件 · ', ' files · ') + formatBytes(result.totalBytes, english));
        setInspectionLoading(false);
      }).catch(error => {
        if (cancelled) return;
        setInspectionError(String(error));
        setInspectionMessage(tr('磁力文件解析失败：', 'Could not resolve magnet files: ') + String(error));
        setInspectionLoading(false);
      });
    }, torrentPath ? 0 : 500);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      void target;
    };
  }, [open, urlText, torrentPath, retryCount, magnetRetryDelaySeconds]);


  useEffect(() => {
    if (!open || needsMagnetMetadata || links.length !== 1 || !isSupportedLink(links[0] || '')) {
      setOrdinaryMetadata(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.downloads.inspectUrl({ url: links[0] || '' }).then(result => {
        if (cancelled) return;
        setOrdinaryMetadata(result);
        setFileName(current => current || result.fileName);
        setInspectionMessage(result.fileName + (result.totalBytes == null ? '' : ' · ' + formatBytes(result.totalBytes, english)));
      }).catch(() => {
        if (!cancelled) setInspectionMessage(tr('文件信息将在下载开始后读取。', 'File information will be read when the download starts.'));
      });
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, urlText, needsMagnetMetadata, authScheme, authUsername, authPassword, allowInsecureAuth]);

  useEffect(() => {
    if (!open || !singleMagnet || preview) return;
    const updateClock = () => setClockNow(Date.now());
    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, [open, singleMagnet, preview]);

  if (!open) return null;
  const selectedSize = preview?.files.filter(file => selectedFiles.has(file.index)).reduce((total, file) => total + file.size, 0) || 0;
  const selectAll = (checked: boolean) => setSelectedFiles(checked ? new Set(preview?.files.map(file => file.index) || []) : new Set());
  const chooseDirectory = async () => {
    setDialogError('');
    try {
      const path = await api.system.chooseDirectory(directory || defaultDirectory || undefined);
      if (path) setDirectory(path);
    } catch (cause) {
      const message = tr('打开文件夹选择器失败：', 'Could not open folder picker: ') + String(cause);
      setDialogError(message);
      onNotify(message);
    }
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const cleanLinks = parseLinks(urlText);
    if (torrentPath) {
      if (!preview || !selectedFiles.size) {
        onNotify(tr('请等待种子文件清单读取完成并至少选择一个文件。', 'Wait for the torrent file list and select at least one file.'));
        return;
      }
    } else if (!cleanLinks.length || cleanLinks.some(link => !isSupportedLink(link))) {
      onNotify(tr('请提供有效的 HTTP、HTTPS、FTP、FTPS 或 Magnet 链接。', 'Enter valid HTTP, HTTPS, FTP, FTPS, or Magnet links.'));
      return;
    } else if (cleanLinks.some(isMagnet) && (cleanLinks.length !== 1 || magnets.length !== 1)) {
      onNotify(tr('一次只能添加一个磁力链接。', 'Add one magnet link at a time.'));
      return;
    } else if (magnets.length && (!preview || !selectedFiles.size)) {
      if (inspectionError) onNotify(tr('磁力元数据解析失败，请点击重新解析。', 'Magnet metadata could not be resolved. Click Retry parsing.'));
      else onNotify(tr('请等待磁力文件清单解析完成。', 'Wait for the magnet file list to finish resolving.'));
      return;
    }
    if (!directory.trim()) {
      onNotify(tr('请选择保存文件夹。', 'Choose a download folder.'));
      return;
    }
    const limit = Number(speedLimit);
    if (!Number.isFinite(limit) || limit < 0 || limit > 1024) {
      onNotify(tr('任务限速必须在 0–1024 MB/s。', 'Task speed limit must be between 0 and 1024 MB/s.'));
      return;
    }
    if (checksum && !/^[a-f0-9]+$/i.test(checksum.trim())) {
      onNotify(tr('校验值必须是十六进制。', 'Checksum must be hexadecimal.'));
      return;
    }
    const scheduled = scheduledAt ? Math.floor(new Date(scheduledAt).getTime() / 1000) : null;
    if (scheduledAt && (!scheduled || scheduled * 1000 < Date.now())) {
      onNotify(tr('计划开始时间必须晚于现在。', 'Scheduled start must be in the future.'));
      return;
    }
    const common = {
      directory: directory.trim(),
      ...(fileName.trim() ? { fileName: fileName.trim() } : {}),
    };
    setSubmitting(true);
    try {
      if (!torrentPath && !magnets.length) {
        const existingTasks = await api.downloads.list();
        const existingBySource = new Map(existingTasks.map(task => [downloadSourceIdentity(task.url), task]));
        const seenSources = new Set<string>();
        for (const url of cleanLinks) {
          const identity = downloadSourceIdentity(url);
          const existing = existingBySource.get(identity);
          if (existing) {
            onNotify(tr('下载任务已存在：' + existing.fileName, 'Task already exists: ' + existing.fileName));
            return;
          }
          if (seenSources.has(identity)) {
            onNotify(tr('输入链接中包含重复任务。', 'The input contains a duplicate task.'));
            return;
          }
          seenSources.add(identity);
        }
      }
      if (torrentPath) {
        await api.downloads.importTorrent({
          torrentPath,
          ...common,
          selectedFileIndices: [...selectedFiles],
        });
      } else if (magnets.length) {
        await api.magnets.add({
          url: cleanLinks[0] || '',
          ...common,
          selectedFileIndices: [...selectedFiles],
        });
      } else {
        const repeatSeconds = repeat === 'daily' ? 86400 : repeat === 'weekly' ? 604800 : null;
        for (const [index, url] of cleanLinks.entries()) {
          const input: AddDownloadInput = {
            url,
            directory: directory.trim(),
            ...(cleanLinks.length === 1 && fileName.trim() ? { fileName: fileName.trim() } : {}),
            ...(category !== 'auto' ? { category } : {}),
            queueName,
            speedLimitBytesSec: limit ? Math.round(limit * 1024 * 1024) : null,
            ...(checksum && cleanLinks.length === 1 ? { checksumAlgorithm, expectedChecksum: checksum.trim() } : {}),
            ...(scheduled ? { scheduledAt: scheduled } : {}),
            ...(repeatSeconds && cleanLinks.length === 1 ? { repeatIntervalSeconds: repeatSeconds } : {}),
            ...(authUsername.trim() ? { authScheme, authUsername: authScheme === 'basic' ? authUsername.trim() : null } : {}),
            ...(authPassword ? { authPassword } : {}),
            ...(allowInsecureAuth ? { allowInsecureAuth: true } : {}),
            ...(referer.trim() ? { referer: referer.trim() } : {}),
            ...(userAgent.trim() ? { userAgent: userAgent.trim() } : {}),
            ...(cookie.trim() ? { cookie: cookie.trim() } : {}),
          };
          await api.downloads.add(input);
          void index;
        }
      }
      onNotify(tr('下载任务已加入。', 'Download task added.'));
      onCreated();
      onClose();
    } catch (error) {
      onNotify(String(error));
    } finally {
      setSubmitting(false);
    }
  };
  const remaining = Math.max(0, Math.ceil((retryAt - clockNow) / 1000));
  const retryAvailable = singleMagnet && !preview && remaining === 0 && (inspectionError.length > 0 || inspectionLoading);
  const visibleInspectionMessage = retryAvailable && inspectionLoading
    ? tr('等待超过设置时间，仍未读取到文件清单。', 'The wait limit elapsed before the file list was ready.')
    : inspectionMessage;
  const retryMagnetParsing = () => {
    if (!retryAvailable) return;
    const now = Date.now();
    setClockNow(now);
    setRetryAt(now + Math.max(1, magnetRetryDelaySeconds) * 1000);
    setInspectionError('');
    setInspectionLoading(true);
    setInspectionMessage(tr('正在重新解析磁力文件清单…', 'Retrying magnet file-list parsing…'));
    setRetryCount(count => count + 1);
  };

  return (
    <div className="modal-backdrop open" id="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <form className="modal fixed-modal-layout" id="downloadForm" onSubmit={submit}>
        <div className="modal-head"><div><h2 id="modalTitle">{torrentPath ? tr('导入种子任务', 'Import torrent task') : tr('新建链接任务', 'New link task')}</h2><p>{tr('粘贴普通链接后自动识别；磁力链接会读取文件清单。', 'Link details are detected automatically; magnet links show their file list.')}</p></div><button type="button" className="close-btn" id="closeModal" onClick={onClose} aria-label={tr('关闭', 'Close')}><svg><use href="#i-close" /></svg></button></div>
        <div className="fixed-modal-content">
          {!torrentPath && <div className="field"><label htmlFor="urlInput">{tr('下载链接', 'Download links')}</label><textarea id="urlInput" required={!torrentPath} autoFocus value={urlText} onChange={event => setUrlText(event.currentTarget.value)} placeholder={tr('粘贴 HTTP/HTTPS、FTP/FTPS 或 Magnet 链接，每行一个', 'Paste HTTP, HTTPS, FTP, FTPS, or magnet links, one per line')} /><div className="field-hint download-type-hint">{magnets.length ? (preview ? tr('磁力文件清单已读取。', 'Magnet file list loaded.') : singleMagnet && inspectionError ? tr('已识别磁力链接，但文件清单解析失败。', 'Magnet link recognized, but the file list could not be parsed.') : singleMagnet ? tr('已识别磁力链接，正在读取文件清单。', 'Magnet link recognized; reading the file list.') : tr('一次只能解析一个磁力链接。', 'Only one magnet link can be resolved at a time.')) : tr('可一次添加多个普通下载链接。', 'You can add multiple ordinary links at once.')}</div>{singleMagnet && inspectionLoading && <div className="magnet-loading-indicator" role="status" aria-label={tr('正在读取磁力文件清单', 'Loading magnet file list')}><span className="magnet-loading-spinner" aria-hidden="true" /></div>}</div>}
          {torrentPath && <div className="field" id="torrentSource"><label>{tr('种子文件', 'Torrent file')}</label><div className="torrent-source-name"><span>{torrentPath}</span></div></div>}
          <div className="field-hint" aria-live="polite">{visibleInspectionMessage}</div>
          {inspectionError && <div className="field-hint" role="alert">{inspectionError}</div>}
          {preview && <section id="magnetFilePicker" className="magnet-file-picker" aria-label={tr('选择磁力文件', 'Select magnet files')}>
            <div className="magnet-file-toolbar"><label className="check"><input type="checkbox" checked={selectedFiles.size === preview.files.length && preview.files.length > 0} onChange={event => selectAll(event.currentTarget.checked)} /><span>{tr('全选文件', 'Select all files')}</span></label><span>{selectedFiles.size} / {preview.files.length} · {formatBytes(selectedSize, english)}</span></div>
            <div className="magnet-file-list">{preview.files.map(file => <label key={file.index} className="magnet-file-row"><input type="checkbox" checked={selectedFiles.has(file.index)} onChange={event => { const checked = event.currentTarget.checked; setSelectedFiles(current => {
              const next = new Set(current);
              if (checked) next.add(file.index); else next.delete(file.index);
              return next;
            }); }} /><span className="magnet-file-path" title={file.path}>{file.path}</span><span className="magnet-file-size">{formatBytes(file.size, english)}</span></label>)}</div>
          </section>}
          <details className="advanced-options"><summary>{tr('高级下载选项（可选）', 'Advanced download options (optional)')}</summary>
            <div className="field"><label htmlFor="filenameInput">{tr('保存文件名', 'File name')}</label><input id="filenameInput" value={fileName} onChange={event => setFileName(event.currentTarget.value)} placeholder={ordinaryMetadata?.fileName || tr('根据链接自动建议', 'Suggested from the link')} /></div>
            {!needsMagnetMetadata && <div className="field"><label>{tr('下载分类', 'Category')}</label><select value={category} onChange={event => setCategory(event.currentTarget.value)}><option value="auto">{tr('按文件类型自动分类', 'Automatic')}</option><option value="documents">{tr('文档', 'Documents')}</option><option value="compressed">{tr('压缩包', 'Archives')}</option><option value="music">{tr('音乐', 'Music')}</option><option value="programs">{tr('程序', 'Applications')}</option><option value="other">{tr('其他', 'Other')}</option></select></div>}
            {!needsMagnetMetadata && <div className="field"><label>{tr('下载队列', 'Queue')}</label><select value={queueName} onChange={event => setQueueName(event.currentTarget.value)}>{queues.map(queue => <option key={queue.name} value={queue.name}>{queue.name === '默认' ? tr('默认', 'Default') : queue.name}</option>)}</select></div>}
            {!needsMagnetMetadata && <div className="field"><label>{tr('此任务限速（MB/s，0 不限速）', 'Task speed limit (MB/s, 0 is unlimited)')}</label><input type="number" min="0" max="1024" step="0.25" value={speedLimit} onChange={event => setSpeedLimit(event.currentTarget.value)} /></div>}
            {!needsMagnetMetadata && <>
              <div className="field"><label>{tr('认证方式', 'Authentication')}</label><select value={authScheme} onChange={event => setAuthScheme(event.currentTarget.value as 'basic' | 'bearer')}><option value="basic">{tr('用户名与密码', 'Username and password')}</option><option value="bearer">HTTP Bearer Token</option></select></div>
              <div className="field"><label>{authScheme === 'bearer' ? 'Bearer Token' : tr('用户名（可选）', 'Username (optional)')}</label><input value={authUsername} onChange={event => setAuthUsername(event.currentTarget.value)} /></div>
              <div className="field"><label>{tr('密码或 Token（可选）', 'Password or token (optional)')}</label><input type="password" value={authPassword} onChange={event => setAuthPassword(event.currentTarget.value)} /></div>
              <label className="check"><input type="checkbox" checked={allowInsecureAuth} onChange={event => setAllowInsecureAuth(event.currentTarget.checked)} /><span>{tr('允许通过未加密 HTTP 发送凭据', 'Allow credentials over unencrypted HTTP')}</span></label>
              <div className="field"><label>Referer</label><input value={referer} onChange={event => setReferer(event.currentTarget.value)} /></div>
              <div className="field"><label>User-Agent</label><input value={userAgent} onChange={event => setUserAgent(event.currentTarget.value)} /></div>
              <div className="field"><label>Cookie</label><textarea rows={2} value={cookie} onChange={event => setCookie(event.currentTarget.value)} /></div>
              <div className="field"><label>{tr('计划开始时间（可选）', 'Schedule (optional)')}</label><input type="datetime-local" value={scheduledAt} onChange={event => setScheduledAt(event.currentTarget.value)} /></div>
              <div className="field"><label>{tr('重复计划', 'Repeat schedule')}</label><select value={repeat} onChange={event => setRepeat(event.currentTarget.value)}><option value="none">{tr('不重复', 'Never')}</option><option value="daily">{tr('每天', 'Daily')}</option><option value="weekly">{tr('每周', 'Weekly')}</option></select></div>
              <div className="field"><label>{tr('校验算法', 'Checksum algorithm')}</label><select value={checksumAlgorithm} onChange={event => setChecksumAlgorithm(event.currentTarget.value)}><option value="sha256">SHA-256</option><option value="sha512">SHA-512</option><option value="sha384">SHA-384</option><option value="sha224">SHA-224</option><option value="sha1">SHA-1</option><option value="md5">MD5</option></select></div>
              <div className="field"><label>{tr('预期校验值（可选）', 'Expected checksum (optional)')}</label><input value={checksum} onChange={event => setChecksum(event.currentTarget.value)} /></div>
            </>}
          </details>
          {dialogError && <p className="field-hint dialog-error" role="alert">{dialogError}</p>}
          <div className="field"><label htmlFor="directoryInput">{tr('保存到', 'Save to')}</label><div className="directory-field"><input id="directoryInput" readOnly value={directory} /><button type="button" onClick={() => void chooseDirectory()}>{tr('选择文件夹', 'Choose folder')}</button></div></div>
        </div>
        <div className="modal-actions"><button type="button" className="secondary-btn" id="cancelModal" onClick={onClose}>{tr('取消', 'Cancel')}</button><button className="add-btn" type={retryAvailable ? 'button' : 'submit'} onClick={retryAvailable ? retryMagnetParsing : undefined} disabled={submitting || (singleMagnet && !preview && !retryAvailable)}>{retryAvailable ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 1-2.34-5.66L20 12" /></svg> : <svg><use href="#i-download" /></svg>}{retryAvailable ? tr('重新解析', 'Retry parsing') : submitting ? tr('正在添加…', 'Adding…') : singleMagnet && !preview ? tr('正在读取清单…', 'Reading file list…') : tr('开始下载', 'Start download')}</button></div>
      </form>
    </div>
  );
}
