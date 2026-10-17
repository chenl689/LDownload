import { useEffect, useMemo, useState } from 'react';
import type { DownloadQueue, SiteCollectionProject } from '../shared/contracts';
import type { RendererApi } from '../shared/ipc';

type CollectionProps = {
  open: boolean;
  api: RendererApi;
  queues: DownloadQueue[];
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  onNotify: (message: string) => void;
  onAddLinks: (links: string[], queueName: string) => Promise<void>;
};

export function CollectionDialog(props: CollectionProps) {
  const { open, api, queues, language, onClose, onNotify, onAddLinks } = props;
  const english = language === 'en-US';
  const tr = (zh: string, en: string) => english ? en : zh;
  const [projects, setProjects] = useState<SiteCollectionProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [startUrl, setStartUrl] = useState('');
  const [depth, setDepth] = useState(2);
  const [pageLimit, setPageLimit] = useState(100);
  const [extensions, setExtensions] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const selected = projects.find(project => project.id === selectedId) || null;
  const progress = useMemo(() => selected ? selected.frontier.length + selected.visitedPages.length : 0, [selected]);

  const reload = async () => {
    try {
      const next = await api.siteCollections.list();
      setProjects(next);
      setSelectedId(current => next.some(project => project.id === current) ? current : next[0]?.id || null);
    } catch (error) {
      onNotify(tr('读取收集项目失败：', 'Could not load collections: ') + String(error));
    }
  };

  useEffect(() => {
    if (!open) return;
    void reload();
    return api.siteCollections.onUpdated(snapshot => {
      setProjects(snapshot.projects);
      setSelectedId(current => snapshot.projects.some(project => project.id === current) ? current : snapshot.projects[0]?.id || null);
    });
  }, [open]);

  useEffect(() => { setChecked(new Set()); }, [selectedId]);

  if (!open) return null;
  const createProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const project = await api.siteCollections.create({
        startUrl,
        maxDepth: depth,
        pageLimit,
        includePatterns: include.split(',').map(value => value.trim()).filter(Boolean),
        excludePatterns: exclude.split(',').map(value => value.trim()).filter(Boolean),
        fileExtensions: extensions.split(',').map(value => value.trim().replace(/^\./, '').toLowerCase()).filter(Boolean),
      });
      setProjects(current => [project, ...current.filter(item => item.id !== project.id)]);
      setSelectedId(project.id);
      onNotify(tr('收集项目已创建。', 'Collection created.'));
    } catch (error) {
      onNotify(tr('创建收集项目失败：', 'Could not create collection: ') + String(error));
    }
  };
  const toggleLink = (url: string) => setChecked(current => {
    const next = new Set(current);
    if (next.has(url)) next.delete(url); else next.add(url);
    return next;
  });
  const setRunning = async (run: boolean) => {
    if (!selected) return;
    try {
      if (run) await api.siteCollections.run(selected.id);
      else await api.siteCollections.stop(selected.id);
      await reload();
    } catch (error) {
      onNotify(tr('收集操作失败：', 'Collection action failed: ') + String(error));
    }
  };
  const deleteProject = async () => {
    if (!selected) return;
    try {
      await api.siteCollections.delete(selected.id);
      setProjects(current => current.filter(project => project.id !== selected.id));
      setSelectedId(null);
      onNotify(tr('项目已删除。', 'Collection deleted.'));
    } catch (error) {
      onNotify(tr('删除项目失败：', 'Could not delete collection: ') + String(error));
    }
  };
  const addSelected = async () => {
    const links = selected?.foundLinks.filter(link => checked.has(link)) || [];
    if (!links.length) return;
    await onAddLinks(links, queues[0]?.name || '默认');
    setChecked(new Set());
  };

  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="collectionTitle">
      <div className="modal collection-modal fixed-modal-layout">
        <div className="modal-head"><div><h2 id="collectionTitle">{tr('站点链接收集', 'Site link collector')}</h2><p>{tr('只访问起始地址的同源页面；遵循 robots.txt，解析静态 HTML 链接，不执行网页脚本。', 'Visits same-origin pages, follows robots.txt, and reads static HTML without running page scripts.')}</p></div><button type="button" className="close-btn" onClick={onClose} aria-label={tr('关闭', 'Close')}><svg><use href="#i-close" /></svg></button></div>
        <div className="fixed-modal-content collection-content"><div className="collection-layout">
          <section className="collection-side" aria-label={tr('新建和选择收集项目', 'Create and select collections')}>
            <form onSubmit={createProject}>
              <div className="field"><label>{tr('起始网页', 'Starting page')}</label><input type="url" required value={startUrl} onChange={event => setStartUrl(event.currentTarget.value)} placeholder="https://example.com/downloads" /></div>
              <div className="directory-field">
                <div className="field flex-field"><label>{tr('链接深度', 'Link depth')}</label><select value={depth} onChange={event => setDepth(Number(event.currentTarget.value))}><option value="0">{tr('仅起始页', 'Start page only')}</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></div>
                <div className="field flex-field"><label>{tr('最多访问页数', 'Maximum pages')}</label><input type="number" min="1" max="200" value={pageLimit} onChange={event => setPageLimit(Number(event.currentTarget.value))} /></div>
              </div>
              <div className="field"><label>{tr('文件扩展名（可选）', 'File extensions (optional)')}</label><input value={extensions} onChange={event => setExtensions(event.currentTarget.value)} placeholder="zip, pdf, epub" /></div>
              <div className="field"><label>{tr('包含 URL（可选）', 'Include URL patterns (optional)')}</label><input value={include} onChange={event => setInclude(event.currentTarget.value)} /></div>
              <div className="field"><label>{tr('排除 URL（可选）', 'Exclude URL patterns (optional)')}</label><input value={exclude} onChange={event => setExclude(event.currentTarget.value)} /></div>
              <button className="add-btn" type="submit"><svg><use href="#i-plus" /></svg>{tr('创建收集项目', 'Create collection')}</button>
            </form>
            <div className="field"><label>{tr('已保存项目', 'Saved collections')}</label><div className="collection-projects" aria-live="polite">
              {projects.length ? projects.map(project => <button type="button" key={project.id} className={'collection-project' + (selectedId === project.id ? ' active' : '')} onClick={() => setSelectedId(project.id)}><strong>{project.startUrl}</strong><small>{tr('深度', 'Depth')} {project.maxDepth} · {project.status}</small></button>) : <div className="collection-empty">{tr('还没有收集项目', 'No collections yet')}</div>}
            </div></div>
          </section>
          <section className="collection-main" aria-label={tr('收集结果', 'Collection results')}>
            <div className="modal-head no-margin"><div><h2>{selected?.startUrl || tr('选择一个项目', 'Choose a collection')}</h2><p>{selected ? tr('已访问 ', 'Visited ') + selected.visitedPages.length + ' / ' + selected.pageLimit + tr(' 页 · 发现 ', ' pages · found ') + selected.foundLinks.length + tr(' 个链接', ' links') : tr('创建或选择左侧项目后开始收集。', 'Create or select a collection on the left.')}</p></div></div>
            <div className="collection-toolbar"><button type="button" disabled={!selected} onClick={() => void setRunning(true)}>{tr('开始 / 继续', 'Start / resume')}</button><button type="button" disabled={!selected || selected.status !== 'running'} onClick={() => void setRunning(false)}>{tr('暂停', 'Pause')}</button><button type="button" disabled={!selected} onClick={() => void deleteProject()}>{tr('删除项目', 'Delete')}</button><button type="button" disabled={!selected?.foundLinks.length} onClick={() => setChecked(new Set(selected?.foundLinks.slice(0, 100) || []))}>{tr('全选前 100 项', 'Select first 100')}</button></div>
            <div className="collection-summary" aria-live="polite">{selected ? tr('扫描队列 ', 'Queue ') + progress + tr(' 项 · ', ' items · ') + selected.status : ''}</div>
            <div className="collection-results">{selected?.foundLinks.length ? selected.foundLinks.map(url => <label key={url} className="collection-result"><input type="checkbox" checked={checked.has(url)} onChange={() => toggleLink(url)} /><span>{url}</span></label>) : <div className="collection-empty">{tr('网页中的文件链接会显示在这里', 'Found links will appear here')}</div>}</div>
          </section>
        </div></div>
        <div className="modal-actions"><button type="button" className="secondary-btn" onClick={onClose}>{tr('关闭', 'Close')}</button><button type="button" className="add-btn" disabled={!checked.size} onClick={() => void addSelected()}><svg><use href="#i-download" /></svg>{tr('加入下载队列', 'Add to download queue')}</button></div>
      </div>
    </div>
  );
}

type BrowserProps = {
  open: boolean;
  api: RendererApi;
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  onNotify: (message: string) => void;
};
export function BrowserDialog(props: BrowserProps) {
  const { open, api, language, onClose, onNotify } = props;
  const english = language === 'en-US';
  const tr = (zh: string, en: string) => english ? en : zh;
  const [browser, setBrowser] = useState<'chrome' | 'edge' | 'firefox'>('chrome');
  const [extensionId, setExtensionId] = useState('');
  useEffect(() => { if (browser === 'firefox') setExtensionId('ldownload@open-source.local'); }, [browser]);
  if (!open) return null;
  const install = async () => {
    try {
      const success = await api.system.installNativeHost(browser, extensionId.trim());
      onNotify(success ? tr('原生消息主机已安装。', 'Native messaging host installed.') : tr('无法安装原生消息主机。', 'Could not install native messaging host.'));
    } catch (error) { onNotify(tr('安装失败：', 'Installation failed: ') + String(error)); }
  };
  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="browserTitle">
      <div className="modal settings-modal">
        <div className="modal-head"><div><h2 id="browserTitle">{tr('浏览器接管', 'Browser integration')}</h2><p>{tr('在浏览器中明确选择链接或当前页资源，再交给 LDownload。', 'Choose links or resources in your browser, then send them to LDownload.')}</p></div><button type="button" className="close-btn" onClick={onClose}><svg><use href="#i-close" /></svg></button></div>
        <div className="field"><label>{tr('1. 选择浏览器并加载扩展', '1. Select a browser and load the extension')}</label><select value={browser} onChange={event => setBrowser(event.currentTarget.value as typeof browser)}><option value="chrome">Chrome</option><option value="edge">Microsoft Edge</option><option value="firefox">Firefox</option></select><div className="field-hint">{tr('打开扩展管理页并加载已解压的扩展文件夹。', 'Open the browser extensions page and load the unpacked extension folder.')}</div><button type="button" className="secondary-btn" onClick={() => void api.system.openExtensionFolder(browser).catch(error => onNotify(String(error)))}>{tr('打开对应扩展文件夹', 'Open extension folder')}</button></div>
        <div className="field"><label>{tr('2. 安装原生消息桥接', '2. Install native messaging bridge')}</label><input value={extensionId} onChange={event => setExtensionId(event.currentTarget.value)} placeholder={tr('浏览器扩展 ID', 'Browser extension ID')} /><button type="button" className="secondary-btn" disabled={!extensionId.trim()} onClick={() => void install()}>{tr('安装原生消息主机', 'Install native messaging host')}</button><div className="field-hint">{tr('主机通过标准 stdin/stdout 通信，不开启本地网络端口。', 'The host communicates over standard input/output and opens no local network port.')}</div></div>
        <div className="field"><label>{tr('3. 注册桌面链接（可选）', '3. Register desktop links (optional)')}</label><button type="button" className="secondary-btn" onClick={() => void api.system.registerProtocols().then(() => onNotify(tr('已注册桌面链接。', 'Desktop links registered.'))).catch(error => onNotify(String(error)))}>{tr('注册 ldownload:// 处理程序', 'Register ldownload:// handler')}</button></div>
        <div className="field"><label>{tr('可用操作', 'Available actions')}</label><div className="field-hint">{tr('右键链接可交给下载器；扩展弹窗可预览当前页链接。自动接管默认关闭。', 'Send links from the context menu or review page links in the extension popup. Automatic interception is off by default.')}</div></div>
        <div className="modal-actions"><button type="button" className="secondary-btn" onClick={onClose}>{tr('关闭', 'Close')}</button></div>
      </div>
    </div>
  );
}
