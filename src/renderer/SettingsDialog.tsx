import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DOWNLOAD_SEGMENT_OPTIONS, type DownloadSettings, type MagnetSettings } from '../shared/contracts';
import type { RendererApi } from '../shared/ipc';

type Props = {
  open: boolean;
  settings: DownloadSettings | null;
  magnetSettings: MagnetSettings | null;
  api: RendererApi;
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  onSaved: (settings: DownloadSettings, magnets: MagnetSettings) => void;
  onNotify: (message: string) => void;
};

const sectionList = [
  ['settingsAppearance', '外观与界面', 'Appearance'],
  ['settingsDownloads', '下载行为', 'Download behavior'],
  ['settingsConnections', '保存与连接', 'Storage and connection'],
  ['settingsSafety', '安全与提示', 'Safety and notifications'],
  ['settingsQueues', '下载队列', 'Download queues'],
  ['settingsBitTorrent', '磁力与种子', 'Magnet and torrent'],
] as const;

function baseMagnetSettings(): MagnetSettings {
  return {
    magnetRetryDelaySeconds: 10,
    torrentUpnpEnabled: false,
    torrentPublicTrackersEnabled: false,
    torrentEngine: 'thunder',
    bundledSdkDirectory: null,
    defaultDownloadDirectory: null,
    virusScannerPath: null,
    virusScannerArguments: [],
  };
}

export function SettingsDialog(props: Props) {
  const { open, settings, magnetSettings, api, language, onClose, onSaved, onNotify } = props;
  const english = language === 'en-US';
  const tr = (zh: string, en: string) => english ? en : zh;
  const [draft, setDraft] = useState<DownloadSettings | null>(settings);
  const [magnetDraft, setMagnetDraft] = useState<MagnetSettings>(magnetSettings || baseMagnetSettings());
  const [proxyPassword, setProxyPassword] = useState('');
  const [queueName, setQueueName] = useState('');
  const [activeSection, setActiveSection] = useState<string>('settingsAppearance');
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const hasDraft = Boolean(draft);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setMagnetDraft(magnetSettings || baseMagnetSettings());
    setProxyPassword('');
    setActiveSection('settingsAppearance');
  }, [open, settings, magnetSettings]);

  useEffect(() => {
    if (!open || !hasDraft) return;
    const container = settingsScrollRef.current;
    if (!container) return;
    const updateActiveSection = () => {
      const rootTop = container.getBoundingClientRect().top;
      const activationLine = rootTop + Math.min(48, container.clientHeight * 0.12);
      let currentId: string = sectionList[0]![0];
      for (const [id] of sectionList) {
        const section = container.querySelector<HTMLElement>('#' + id);
        if (section && section.getBoundingClientRect().top <= activationLine) currentId = id;
      }
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) currentId = sectionList[sectionList.length - 1]![0];
      setActiveSection(previous => previous === currentId ? previous : currentId);
    };
    container.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);
    updateActiveSection();
    return () => {
      container.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, [open, hasDraft]);

  if (!open) return null;
  if (!draft) {
    return <div className="modal-backdrop open" role="dialog" aria-modal="true"><section className="modal settings-modal"><p>{tr('正在读取设置…', 'Loading settings…')}</p><button type="button" className="secondary-btn" onClick={onClose}>{tr('关闭', 'Close')}</button></section></div>;
  }

  const update = <K extends keyof DownloadSettings>(key: K, value: DownloadSettings[K]) => {
    setDraft(current => current ? { ...current, [key]: value } : current);
  };
  const updateMagnet = <K extends keyof MagnetSettings>(key: K, value: MagnetSettings[K]) => {
    setMagnetDraft(current => ({ ...current, [key]: value }));
  };
  const toggleList = (key: 'visibleColumns' | 'toolbarButtons', value: string) => {
    const current = draft[key];
    update(key, current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  };
  const changeDirectory = async () => {
    const selected = await api.system.chooseDirectory(draft.defaultDownloadDirectory || undefined);
    if (selected) update('defaultDownloadDirectory', selected);
  };
  const changeMagnetDirectory = async () => {
    const selected = await api.system.chooseDirectory(magnetDraft.defaultDownloadDirectory || undefined);
    if (selected) updateMagnet('defaultDownloadDirectory', selected);
  };
  const createQueue = async () => {
    try {
      const result = await api.downloads.createQueue(queueName);
      update('queues', result.queues);
      setQueueName('');
      onNotify(tr('下载队列已创建。', 'Queue created.'));
    } catch (error) {
      onNotify(tr('创建队列失败：', 'Could not create queue: ') + String(error));
    }
  };
  const changeQueue = async (name: string, action: 'toggle' | 'delete') => {
    const queue = draft.queues.find(item => item.name === name);
    if (!queue) return;
    try {
      const result = action === 'toggle'
        ? await api.downloads.setQueuePaused(name, !queue.paused)
        : await api.downloads.deleteQueue(name);
      update('queues', result.queues);
    } catch (error) {
      onNotify(tr('队列操作失败：', 'Queue operation failed: ') + String(error));
    }
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const saved = await api.downloads.updateSettings({
        ...draft,
        proxyPassword: proxyPassword || null,
      });
      const savedMagnet = await api.magnets.updateSettings({
        ...magnetDraft,
        torrentEngine: 'thunder',
        bundledSdkDirectory: magnetDraft.bundledSdkDirectory,
      });
      onSaved(saved, savedMagnet);
      onNotify(tr('设置已保存。', 'Settings saved.'));
      onClose();
    } catch (error) {
      onNotify(tr('保存设置失败：', 'Could not save settings: ') + String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <form className="modal settings-modal" id="settingsForm" onSubmit={save}>
        <div className="modal-head">
          <div><h2 id="settingsTitle">{tr('下载设置', 'Download settings')}</h2><p>{tr('从左侧选择分类，在右侧查看和修改设置。', 'Choose a category on the left to view and edit its settings.')}</p></div>
          <button type="button" className="close-btn" aria-label={tr('关闭', 'Close')} onClick={onClose}><svg><use href="#i-close" /></svg></button>
        </div>
        <div className="settings-content">
          <nav className="settings-navigation" aria-label={tr('设置分类', 'Settings categories')}>
            {sectionList.map(([id, zh, en]) => <button key={id} type="button" className={'settings-nav-item' + (activeSection === id ? ' active' : '')} onClick={() => {
              setActiveSection(id);
              const container = settingsScrollRef.current;
              const section = container?.querySelector<HTMLElement>('#' + id);
              if (container && section) {
                const top = section.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
                container.scrollTo({ top, behavior: 'smooth' });
              }
            }}><span>{tr(zh, en)}</span><small>{tr('选择分类查看选项', 'Choose a settings section')}</small></button>)}
          </nav>
          <div ref={settingsScrollRef} className="settings-scroll" role="region" aria-label={tr('设置内容', 'Settings content')}>
            <section className="settings-section" id="settingsAppearance">
              <h3>{tr('外观与界面', 'Appearance')}</h3>
              <div className="field"><label>{tr('界面语言', 'Interface language')}</label><select value={draft.language} onChange={event => update('language', event.currentTarget.value as DownloadSettings['language'])}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></div>
              <div className="field"><label>{tr('工具栏按钮', 'Toolbar buttons')}</label><div className="column-options">
                {([['theme', '主题', 'Theme'], ['notifications', '通知', 'Notifications'], ['import', '导入', 'Import'], ['new-download', '新建下载', 'New download']] as const).map(([key, zh, en]) => <label key={key}><input type="checkbox" checked={draft.toolbarButtons.includes(key)} onChange={() => toggleList('toolbarButtons', key)} />{tr(zh, en)}</label>)}
              </div></div>
              <div className="field"><label>{tr('任务表显示列', 'Task list columns')}</label><div className="column-options">
                {([['progress', '进度', 'Progress'], ['size', '大小', 'Size'], ['speed', '速度', 'Speed'], ['status', '状态', 'Status']] as const).map(([key, zh, en]) => <label key={key}><input type="checkbox" checked={draft.visibleColumns.includes(key)} onChange={() => toggleList('visibleColumns', key)} />{tr(zh, en)}</label>)}
              </div></div>
              <div className="field"><label className="check"><input type="checkbox" checked={draft.minimizeToTray} onChange={event => update('minimizeToTray', event.currentTarget.checked)} /><span>{tr('关闭窗口时最小化到系统托盘', 'Minimize to tray when closing')}</span></label></div>
              <div className="field"><label className="check"><input type="checkbox" checked={draft.launchAtLogin} onChange={event => update('launchAtLogin', event.currentTarget.checked)} /><span>{tr('登录 Windows 时启动 LDownload', 'Start LDownload when you sign in')}</span></label></div>
            </section>
            <section className="settings-section" id="settingsDownloads">
              <h3>{tr('下载行为', 'Download behavior')}</h3>
              <div className="field"><label>{tr('并发下载任务数', 'Concurrent downloads')}</label><input type="number" min="1" max="10" value={draft.maxConcurrentDownloads} onChange={event => update('maxConcurrentDownloads', Number(event.currentTarget.value))} /></div>
              <div className="field"><label>{tr('普通下载分段数', 'Ordinary download segments')}</label><select value={draft.segmentsPerDownload} onChange={event => update('segmentsPerDownload', Number(event.currentTarget.value) as DownloadSettings['segmentsPerDownload'])}>{DOWNLOAD_SEGMENT_OPTIONS.map(count => <option key={count} value={count}>{count}</option>)}</select><div className="field-hint">{tr('支持 Range 且文件不小于 4 MiB 时，按所选数量固定分段并同时开始下载；完成的分段会协助剩余最慢的分段。选 1 表示单连接。', 'For files at least 4 MiB when Range is supported, the selected number of fixed segments start together. A completed segment then helps the slowest remaining segment. Choose 1 for a single connection.')}</div></div>
              <div className="field"><label>{tr('连接超时（秒）', 'Connection timeout (seconds)')}</label><input type="number" min="5" max="300" value={draft.connectTimeoutSeconds} onChange={event => update('connectTimeoutSeconds', Number(event.currentTarget.value))} /></div>
              <div className="field"><label>{tr('失败后的自动重试次数', 'Automatic retries')}</label><input type="number" min="0" max="10" value={draft.maxRetries} onChange={event => update('maxRetries', Number(event.currentTarget.value))} /></div>
              <div className="field"><label>{tr('下载完成后', 'After downloads finish')}</label><select value={draft.completionAction} onChange={event => update('completionAction', event.currentTarget.value as DownloadSettings['completionAction'])}>
                <option value="none">{tr('只显示完成通知', 'Show a completion notice')}</option><option value="open_file">{tr('自动打开文件', 'Open the file')}</option><option value="open_folder">{tr('打开所在文件夹', 'Open containing folder')}</option><option value="exit">{tr('全部成功后询问是否退出', 'Ask to quit after all downloads succeed')}</option><option value="shutdown">{tr('全部成功后询问是否关机', 'Ask to shut down after all downloads succeed')}</option>
              </select></div>
              <div className="field"><label>{tr('普通下载限速（MB/s，0 表示不限速）', 'Ordinary speed limit (MB/s, 0 is unlimited)')}</label><input type="number" min="0" max="1024" step="0.25" value={draft.speedLimitBytesSec / 1024 / 1024} onChange={event => update('speedLimitBytesSec', Math.round(Number(event.currentTarget.value) * 1024 * 1024))} /></div>
            </section>
            <section className="settings-section" id="settingsConnections">
              <h3>{tr('保存与连接', 'Storage and connection')}</h3>
              <div className="field"><label>{tr('默认保存文件夹', 'Default download folder')}</label><div className="directory-field"><input readOnly value={draft.defaultDownloadDirectory || ''} /><button type="button" onClick={() => void changeDirectory()}>{tr('更改', 'Change')}</button></div></div>
              <div className="field"><label>{tr('代理', 'Proxy')}</label><select value={draft.proxyMode} onChange={event => update('proxyMode', event.currentTarget.value as DownloadSettings['proxyMode'])}><option value="system">{tr('系统代理（自动配置）', 'System proxy (automatic)')}</option><option value="custom">{tr('自定义代理（HTTP/HTTPS/SOCKS5）', 'Custom proxy (HTTP/HTTPS/SOCKS5)')}</option><option value="disabled">{tr('直接连接（不使用代理）', 'Direct connection')}</option></select></div>
              {draft.proxyMode === 'system' && <div className="field-hint">{tr('HTTP/HTTPS 下载按系统代理与 PAC 配置连接；FTP/FTPS 暂不支持代理。', 'HTTP/HTTPS downloads use the operating system proxy and PAC rules; FTP/FTPS currently require a direct connection.')}</div>}
              {draft.proxyMode === 'custom' && <>
                <div className="field"><label>{tr('代理地址', 'Proxy URL')}</label><input value={draft.proxyUrl || ''} onChange={event => update('proxyUrl', event.currentTarget.value)} placeholder="socks5://127.0.0.1:1080" /></div>
                <div className="field"><label>{tr('代理用户名（可选）', 'Proxy username (optional)')}</label><input value={draft.proxyUsername || ''} onChange={event => update('proxyUsername', event.currentTarget.value)} /></div>
                <div className="field"><label>{tr('代理密码', 'Proxy password')}</label><input type="password" value={proxyPassword} onChange={event => setProxyPassword(event.currentTarget.value)} placeholder={tr('留空保留已保存密码', 'Leave blank to keep saved password')} /></div>
                <div className="field"><label className="check"><input type="checkbox" checked={draft.allowInsecureProxyAuth} onChange={event => update('allowInsecureProxyAuth', event.currentTarget.checked)} /><span>{tr('允许通过未加密 HTTP 代理发送凭据', 'Allow credentials over an unencrypted HTTP proxy')}</span></label></div>
              </>}
              <div className="field"><label>{tr('磁力与种子的默认保存文件夹', 'Default folder for magnet and torrent downloads')}</label><div className="directory-field"><input readOnly value={magnetDraft.defaultDownloadDirectory || ''} /><button type="button" onClick={() => void changeMagnetDirectory()}>{tr('更改', 'Change')}</button></div></div>
            </section>
            <section className="settings-section" id="settingsSafety">
              <h3>{tr('安全与提示', 'Safety and notifications')}</h3>
              <div className="field"><label>{tr('病毒扫描器（可选）', 'Virus scanner (optional)')}</label><input value={draft.virusScannerPath || ''} onChange={event => update('virusScannerPath', event.currentTarget.value || null)} /></div>
              <div className="field"><label>{tr('扫描参数（每行一项）', 'Scanner arguments (one per line)')}</label><textarea rows={3} value={draft.virusScannerArguments.join('\n')} onChange={event => update('virusScannerArguments', event.currentTarget.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))} /></div>
              <div className="field"><label className="check"><input type="checkbox" checked={draft.clipboardMonitorEnabled} onChange={event => update('clipboardMonitorEnabled', event.currentTarget.checked)} /><span>{tr('应用运行期间监控剪贴板中的链接', 'Monitor clipboard links while the app runs')}</span></label><div className="field-hint">{tr('发现链接后先提示，确认后再加入下载。', 'The app asks before adding links it finds.')}</div></div>
            </section>
            <section className="settings-section" id="settingsQueues">
              <h3>{tr('下载队列', 'Download queues')}</h3>
              <div className="field"><label>{tr('命名下载队列', 'Named download queues')}</label><div className="directory-field"><input value={queueName} maxLength={40} onChange={event => setQueueName(event.currentTarget.value)} placeholder={tr('例如：工作任务', 'e.g. Work tasks')} /><button type="button" onClick={() => void createQueue()}>{tr('创建', 'Create')}</button></div>
                <div className="queue-settings-list">{draft.queues.map(queue => <div className="queue-setting-row" key={queue.name}><span className="queue-setting-name">{queue.name === '默认' ? tr('默认', 'Default') : queue.name}{queue.paused ? ' · ' + tr('已停止', 'Paused') : ''}</span><button type="button" onClick={() => void changeQueue(queue.name, 'toggle')}>{queue.paused ? tr('启动', 'Start') : tr('停止', 'Pause')}</button><button type="button" disabled={queue.name === '默认'} onClick={() => void changeQueue(queue.name, 'delete')}>{tr('删除', 'Delete')}</button></div>)}</div>
              </div>
            </section>
            <section className="settings-section" id="settingsBitTorrent">
              <h3>{tr('磁力与种子', 'Magnet and torrent')}</h3>
              <p className="field-hint">{tr('固定使用此安装包内随附的迅雷 SDK，不会查找系统中其他 SDK。', 'Uses only the Thunder SDK bundled with this app.')}</p>
              <div className="field"><label>{tr('磁力解析倒计时（秒）', 'Magnet metadata retry delay (seconds)')}</label><input type="number" min="1" max="300" value={magnetDraft.magnetRetryDelaySeconds} onChange={event => updateMagnet('magnetRetryDelaySeconds', Number(event.currentTarget.value))} /></div>
              <div className="field"><label className="check"><input type="checkbox" checked={magnetDraft.torrentUpnpEnabled} onChange={event => updateMagnet('torrentUpnpEnabled', event.currentTarget.checked)} /><span>{tr('允许 UPnP 端口映射', 'Allow UPnP port mapping')}</span></label></div>
              <div className="field"><label className="check"><input type="checkbox" checked={magnetDraft.torrentPublicTrackersEnabled} onChange={event => updateMagnet('torrentPublicTrackersEnabled', event.currentTarget.checked)} /><span>{tr('为公开种子补充公共 Tracker', 'Add public trackers to public torrents')}</span></label></div>
              <div className="field"><label>{tr('磁力文件病毒扫描器（可选）', 'Magnet file scanner (optional)')}</label><input value={magnetDraft.virusScannerPath || ''} onChange={event => updateMagnet('virusScannerPath', event.currentTarget.value || null)} /></div>
              <div className="field"><label>{tr('扫描参数（每行一项）', 'Scanner arguments (one per line)')}</label><textarea rows={2} value={magnetDraft.virusScannerArguments.join('\n')} onChange={event => updateMagnet('virusScannerArguments', event.currentTarget.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))} /></div>
              <div className="field"><label>{tr('安装包中的迅雷 SDK 路径', 'Bundled Thunder SDK path')}</label><input readOnly value={magnetDraft.bundledSdkDirectory || tr('运行时检查安装包副本', 'Detected from bundled app resources')} /></div>
            </section>
          </div>
        </div>
        <div className="modal-actions"><button type="button" className="secondary-btn" onClick={onClose}>{tr('取消', 'Cancel')}</button><button type="submit" className="add-btn" disabled={busy}>{busy ? tr('保存中…', 'Saving…') : tr('保存设置', 'Save settings')}</button></div>
      </form>
    </div>
  );
}
