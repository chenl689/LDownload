(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (globalThis.__ldownloadAutoCaptureInstalled) return;
  globalThis.__ldownloadAutoCaptureInstalled = true;
  let enabled = false;
  api.storage.local.get({ autoCapture: false }).then(value => { enabled = Boolean(value.autoCapture); });
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.autoCapture) enabled = Boolean(changes.autoCapture.newValue); });
  const fileExtension = /\.(?:7z|apk|avi|bz2|cab|dmg|docx?|exe|flac|gz|iso|m3u8|m4a|mkv|mov|mp3|mp4|msi|pdf|pkg|pptx?|rar|rpm|tar|torrent|wav|webm|wma|wmv|xlsx?|xz|zip)(?:$)/i;
  function getDownloadAnchor(event) {
    for (const node of event.composedPath()) {
      if (node instanceof HTMLAnchorElement && node.href) return node;
    }
    return null;
  }
  document.addEventListener('click', event => {
    if (!enabled || event.button !== 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = getDownloadAnchor(event);
    if (!anchor) return;
    let url;
    try { url = new URL(anchor.href); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) return;
    if (!anchor.hasAttribute('download') && !fileExtension.test(url.pathname)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void api.runtime.sendMessage({ type: 'ldownload-auto-capture-click', url: url.href })
      .catch(error => console.warn('[LDownload capture] Could not hand off clicked download:', error));
  }, true);
})();
