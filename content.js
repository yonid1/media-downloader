// Scans the page for <video> and <audio> elements and reports their sources
// to the background worker. Network requests are caught separately there.
(() => {
  if (window.__mediaDownloaderLoaded) return;
  window.__mediaDownloaderLoaded = true;

  const isTop = window === window.top;
  const seen = new Set();
  let pending = [];
  let hasBlob = false;
  let blobReported = false;
  let lastTitle = '';
  let flushTimer = null;
  let scanTimer = null;

  function kindOf(el) {
    if (el.tagName === 'AUDIO') return 'audio';
    if (el.tagName === 'VIDEO') return 'video';
    return null;
  }

  function consider(el) {
    if (!el || !el.tagName) return;
    if (el.tagName === 'SOURCE') { consider(el.parentElement); return; }
    const kind = kindOf(el);
    if (!kind) return;

    const urls = [el.currentSrc, el.src];
    el.querySelectorAll('source[src]').forEach((s) => urls.push(s.src));

    for (const u of urls) {
      if (!u) continue;
      if (u.startsWith('blob:') || u.startsWith('mediasource:')) { hasBlob = true; continue; }
      if (!/^https?:/i.test(u) || seen.has(u)) continue;
      seen.add(u);
      pending.push({ url: u, kind });
    }
    scheduleFlush();
  }

  function scan() {
    document.querySelectorAll('video, audio').forEach(consider);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 300);
  }

  function flush() {
    flushTimer = null;
    const title = isTop ? document.title : '';
    const blobNews = hasBlob && !blobReported;
    if (!pending.length && !blobNews && title === lastTitle) return;
    const items = pending;
    pending = [];
    lastTitle = title;
    blobReported = hasBlob;
    try {
      chrome.runtime.sendMessage({ type: 'page-media', items, hasBlob, title, top: isTop })
        .catch(() => {});
    } catch {
      // Extension was reloaded; this old content script can no longer talk to it.
    }
  }

  // Media events don't bubble, but they do pass through the capture phase.
  for (const ev of ['loadstart', 'loadedmetadata', 'play']) {
    document.addEventListener(ev, (e) => consider(e.target), true);
  }

  new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 800);
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  });

  scan();
})();
