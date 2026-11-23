'use strict';

// ---------- Media classification ----------

const MEDIA_EXT = {
  mp4: 'video', m4v: 'video', webm: 'video', mkv: 'video', mov: 'video', avi: 'video',
  ogv: 'video', flv: 'video', '3gp': 'video', wmv: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio',
  wav: 'audio', flac: 'audio', weba: 'audio', wma: 'audio',
  m3u8: 'stream', mpd: 'stream'
};

// Pieces of a segmented stream — useless on their own, and they would flood the list.
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa']);
const SEGMENT_MIME = new Set(['video/mp2t', 'video/iso.segment', 'audio/iso.segment']);

const MIME_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/x-flv': 'flv',
  'video/3gpp': '3gp', 'video/x-ms-wmv': 'wmv', 'video/x-m4v': 'm4v',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/webm': 'weba', 'audio/x-ms-wma': 'wma',
  'application/vnd.apple.mpegurl': 'm3u8', 'application/x-mpegurl': 'm3u8',
  'audio/mpegurl': 'm3u8', 'audio/x-mpegurl': 'm3u8', 'application/dash+xml': 'mpd'
};

const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/force-download']);

function extOf(name) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function lastSegment(url) {
  try {
    const path = new URL(url).pathname;
    const seg = path.split('/').filter(Boolean).pop() || '';
    try { return decodeURIComponent(seg); } catch { return seg; }
  } catch {
    return '';
  }
}

/** Returns {kind, ext} for a media URL, or null if it is not a downloadable media file. */
function classify(url, mime) {
  mime = (mime || '').toLowerCase();
  const urlExt = extOf(lastSegment(url));

  if (SEGMENT_MIME.has(mime) || SEGMENT_EXT.has(urlExt)) return null;

  if (MIME_EXT[mime]) {
    const ext = MIME_EXT[mime];
    if (ext === 'm3u8' || ext === 'mpd') return { kind: 'stream', ext };
    const kind = mime.startsWith('audio/') ? 'audio' : 'video';
    // Prefer the URL's own extension when it agrees on the kind (e.g. .m4v served as video/mp4).
    return { kind, ext: MEDIA_EXT[urlExt] === kind ? urlExt : ext };
  }
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    const kind = mime.startsWith('audio/') ? 'audio' : 'video';
    return { kind, ext: MEDIA_EXT[urlExt] ? urlExt : mime.split('/')[1].replace(/^x-/, '').slice(0, 5) };
  }
  if (MEDIA_EXT[urlExt] && GENERIC_MIME.has(mime)) {
    return { kind: MEDIA_EXT[urlExt], ext: urlExt };
  }
  return null;
}

// Byte-range fragments of adaptive players (e.g. ...&range=0-65535) are not whole files.
// Beeps, clicks and notification sounds (e.g. YouTube's voice-search sounds) are not
// what anyone wants to download; real songs and videos are far bigger than this.
const MIN_MEDIA_BYTES = 20 * 1024;
const JUNK_PATTERNS = [/^https:\/\/www\.youtube\.com\/s\/search\/audio\//];
const junkUrls = new Set();

function isJunk(url) {
  return junkUrls.has(url) || JUNK_PATTERNS.some((re) => re.test(url));
}

function looksLikeFragment(url) {
  try {
    const q = new URL(url).searchParams;
    return q.has('range') || q.has('bytestart') || q.has('byterange');
  } catch {
    return false;
  }
}

function headerMap(headers) {
  const out = {};
  for (const h of headers || []) out[h.name.toLowerCase()] = h.value || '';
  return out;
}

function filenameFromDisposition(cd) {
  if (!cd) return '';
  let m = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  m = /filename\s*=\s*"([^"]+)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  return m ? m[1].trim() : '';
}

function sizeFromHeaders(status, h) {
  if (status === 206 && h['content-range']) {
    const total = h['content-range'].split('/')[1];
    const n = parseInt(total, 10);
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseInt(h['content-length'], 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------- Per-tab state (kept in storage.session so it survives worker restarts) ----------

const MAX_ITEMS = 150;
const cache = new Map();   // tabId -> state
const chains = new Map();  // tabId -> promise; serialises read-modify-write per tab

const keyFor = (tabId) => 't' + tabId;

function withTab(tabId, fn) {
  const prev = chains.get(tabId) || Promise.resolve();
  const next = prev.then(async () => {
    let state = cache.get(tabId);
    if (!state) {
      const got = await chrome.storage.session.get(keyFor(tabId));
      state = got[keyFor(tabId)] || { title: '', hasBlob: false, items: [] };
      cache.set(tabId, state);
    }
    if (await fn(state)) {
      await chrome.storage.session.set({ [keyFor(tabId)]: state });
      updateBadge(tabId, state);
    }
    return state;
  }).catch((err) => {
    console.warn('media-downloader:', err);
    return cache.get(tabId);
  });
  chains.set(tabId, next);
  return next;
}

function addItem(tabId, item) {
  return withTab(tabId, (state) => {
    const existing = state.items.find((i) => i.url === item.url);
    if (existing) {
      let changed = false;
      for (const k of ['size', 'mime', 'filename', 'ext']) {
        if (!existing[k] && item[k]) { existing[k] = item[k]; changed = true; }
      }
      return changed;
    }
    state.items.push(item);
    if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
    return true;
  });
}

function clearTab(tabId) {
  return withTab(tabId, (state) => {
    state.items = [];
    state.hasBlob = false;
    return true;
  });
}

function updateBadge(tabId, state) {
  const n = state.items.length;
  const text = n === 0 ? '' : n > 99 ? '99+' : String(n);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

chrome.action.setBadgeBackgroundColor({ color: '#5B4BDB' }).catch(() => {});
if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  cache.delete(tabId);
  chains.delete(tabId);
  chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
});

// ---------- Network detection ----------

const NET_FILTER = {
  urls: ['<all_urls>'],
  types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other']
};

// A new page in the tab starts a fresh list.
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId >= 0) clearTab(d.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return;
  if (d.statusCode !== 200 && d.statusCode !== 206) return;
  if (!/^https?:/i.test(d.url)) return;

  const h = headerMap(d.responseHeaders);
  const mime = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  const info = classify(d.url, mime);
  if (!info) return;
  if (info.kind !== 'stream' && looksLikeFragment(d.url)) return;
  if (isJunk(d.url)) return;

  const size = info.kind === 'stream' ? 0 : sizeFromHeaders(d.statusCode, h);
  if (size > 0 && size < MIN_MEDIA_BYTES) {
    junkUrls.add(d.url);
    return;
  }

  addItem(d.tabId, {
    url: d.url,
    kind: info.kind,
    ext: info.ext,
    mime,
    size,
    filename: filenameFromDisposition(h['content-disposition']),
    source: 'network',
    time: Date.now()
  });
}, NET_FILTER, ['responseHeaders']);

// ---------- Downloading ----------

function sanitize(name) {
  let s = (name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 150) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
    s = s.slice(0, 150 - ext.length).trim() + ext;
  }
  return s;
}

function buildFilename(item, pageTitle) {
  let name = item.filename || '';
  if (!name) {
    const seg = lastSegment(item.url);
    if (MEDIA_EXT[extOf(seg)]) name = seg;
  }
  if (!name && pageTitle && item.ext) name = `${pageTitle}.${item.ext}`;
  if (name && !extOf(name) && item.ext) name += '.' + item.ext;
  return sanitize(name);
}

async function startDownload(item, pageTitle) {
  const { saveAs = false } = await chrome.storage.sync.get('saveAs');
  const filename = buildFilename(item, pageTitle);
  const opts = { url: item.url, saveAs, conflictAction: 'uniquify' };
  if (filename) opts.filename = filename;
  try {
    return await chrome.downloads.download(opts);
  } catch (err) {
    // Chrome rejects some filenames; fall back to letting it pick one.
    if (!opts.filename) throw err;
    delete opts.filename;
    return chrome.downloads.download(opts);
  }
}

async function tabTitle(tabId, state) {
  if (state && state.title) return state.title;
  try { return (await chrome.tabs.get(tabId)).title || ''; } catch { return ''; }
}

// ---------- Messages from the page scanner and the popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'page-media') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null || tabId < 0) return;
    withTab(tabId, (state) => {
      let changed = false;
      if (msg.top && msg.title && state.title !== msg.title) { state.title = msg.title; changed = true; }
      if (msg.hasBlob && !state.hasBlob) { state.hasBlob = true; changed = true; }
      return changed;
    });
    for (const it of msg.items || []) {
      if (!/^https?:/i.test(it.url)) continue;
      const urlExt = extOf(lastSegment(it.url));
      if (SEGMENT_EXT.has(urlExt) || isJunk(it.url)) continue;
      const kind = MEDIA_EXT[urlExt] || it.kind;
      addItem(tabId, {
        url: it.url,
        kind,
        ext: MEDIA_EXT[urlExt] ? urlExt : '',
        mime: '',
        size: 0,
        filename: '',
        source: 'page',
        time: Date.now()
      });
    }
    return;
  }

  if (msg && msg.type === 'download') {
    (async () => {
      const state = await withTab(msg.tabId, () => false);
      const title = await tabTitle(msg.tabId, state);
      const errors = [];
      let started = 0;
      for (const url of msg.urls || []) {
        const item = (state && state.items.find((i) => i.url === url)) || { url, ext: extOf(lastSegment(url)) };
        try { await startDownload(item, title); started++; } catch (e) { errors.push(String(e && e.message || e)); }
      }
      sendResponse({ started, errors });
    })();
    return true; // async response
  }

  if (msg && msg.type === 'clear') {
    clearTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------- Right-click menu ----------

function linkPatterns() {
  const out = [];
  for (const [ext, kind] of Object.entries(MEDIA_EXT)) {
    if (kind === 'stream') continue;
    out.push(`*://*/*.${ext}*`, `*://*/*.${ext.toUpperCase()}*`);
  }
  return out;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dl-media',
      title: 'הורד את הקובץ הזה',
      contexts: ['video', 'audio'],
      targetUrlPatterns: ['http://*/*', 'https://*/*']
    });
    chrome.contextMenus.create({
      id: 'dl-link',
      title: 'הורד את קובץ המדיה מהקישור',
      contexts: ['link'],
      targetUrlPatterns: linkPatterns()
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'dl-media' ? info.srcUrl : info.linkUrl;
  if (!url || !/^https?:/i.test(url)) return;
  const tabId = tab && tab.id;
  const state = tabId != null && tabId >= 0 ? cache.get(tabId) : null;
  const known = state && state.items.find((i) => i.url === url);
  const urlExt = extOf(lastSegment(url));
  const item = known || { url, ext: MEDIA_EXT[urlExt] ? urlExt : '' };
  try {
    await startDownload(item, (state && state.title) || (tab && tab.title) || '');
  } catch (e) {
    console.warn('media-downloader: download failed', e);
  }
});

// ---------- YouTube via yt-dlp (Chrome native messaging, see native-host/) ----------

const NATIVE_HOST = 'com.mediadownloader.ytdlp';
let nativePort = null;
let ytChain = Promise.resolve([]);

function updateJobs(fn) {
  ytChain = ytChain.then(async () => {
    const { ytJobs = [] } = await chrome.storage.session.get('ytJobs');
    if (fn(ytJobs) !== false) await chrome.storage.session.set({ ytJobs: ytJobs.slice(0, 8) });
    return ytJobs;
  }).catch((err) => {
    console.warn('media-downloader:', err);
    return [];
  });
  return ytChain;
}

// A fresh worker has no connection to yt-dlp, so nothing can still be running.
updateJobs((jobs) => {
  let changed = false;
  for (const j of jobs) {
    if (j.status === 'running') { j.status = 'error'; j.error = 'ההורדה הופסקה'; changed = true; }
  }
  return changed;
});

function friendlyNativeError(msg) {
  if (/not found/i.test(msg)) return 'yt-dlp עדיין לא מחובר לתוסף. הריצו פעם אחת את install.sh שבתיקיית התוסף (הוראות ב-README).';
  if (/forbidden/i.test(msg)) return 'החיבור ל-yt-dlp שייך לתוסף אחר. הריצו שוב את install.sh.';
  if (/exited/i.test(msg)) return 'הגשר ל-yt-dlp לא הצליח לפעול. הריצו שוב את install.sh שבתיקיית התוסף.';
  return msg;
}

function getNativePort() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener(() => {
    const reason = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
    if (nativePort === port) nativePort = null;
    updateJobs((jobs) => {
      let changed = false;
      for (const j of jobs) {
        if (j.status === 'running') {
          j.status = 'error';
          j.error = reason ? friendlyNativeError(reason) : 'החיבור ל-yt-dlp נסגר';
          changed = true;
        }
      }
      return changed;
    });
  });
  nativePort = port;
  return port;
}

function onNativeMessage(msg) {
  if (!msg || !msg.id) return;
  updateJobs((jobs) => {
    const j = jobs.find((x) => x.id === msg.id);
    if (!j) return false;
    if (msg.type === 'progress') {
      if (msg.stage === 'download' && msg.percent != null) {
        // Video and audio come down one after the other; each starts again from 0%.
        if (j.stage === 'download' && msg.percent + 40 < (j.percent || 0)) j.part = (j.part || 1) + 1;
        j.percent = msg.percent;
      }
      j.stage = msg.stage;
      j.speed = msg.speed || '';
      j.eta = msg.eta || '';
    } else if (msg.type === 'done') {
      j.status = 'done';
      j.file = msg.file;
      j.percent = 100;
    } else if (msg.type === 'error') {
      j.status = msg.code === 'cancelled' ? 'cancelled' : 'error';
      j.error = msg.message || '';
    }
    return true;
  }).then((jobs) => {
    // Close the bridge once nothing is downloading, so the helper process exits.
    if (nativePort && !jobs.some((j) => j.status === 'running')) {
      nativePort.disconnect();
      nativePort = null;
    }
  });
}

async function checkYtdlp() {
  try {
    const status = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'check' });
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: friendlyNativeError(String(e && e.message || e)) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('yt-')) return;

  if (msg.type === 'yt-check') {
    checkYtdlp().then(sendResponse);
    return true;
  }

  if (msg.type === 'yt-download') {
    const job = {
      id: crypto.randomUUID(),
      url: msg.url,
      videoId: msg.videoId || '',
      title: msg.title || msg.url,
      mode: msg.mode === 'audio' ? 'audio' : 'video',
      sponsorblock: !!msg.sponsorblock,
      status: 'running',
      stage: 'starting',
      percent: 0,
      part: 1,
      time: Date.now()
    };
    updateJobs((jobs) => { jobs.unshift(job); }).then(() => {
      try {
        getNativePort().postMessage({ cmd: 'download', id: job.id, url: job.url, mode: job.mode, sponsorblock: job.sponsorblock });
      } catch (e) {
        onNativeMessage({ type: 'error', id: job.id, message: friendlyNativeError(String(e && e.message || e)) });
      }
      sendResponse({ id: job.id });
    });
    return true;
  }

  if (msg.type === 'yt-cancel') {
    if (nativePort) nativePort.postMessage({ cmd: 'cancel', id: msg.id });
    return;
  }

  if (msg.type === 'yt-reveal') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'reveal', path: msg.path })
      .then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'yt-clear') {
    updateJobs((jobs) => {
      const keep = jobs.filter((j) => j.status === 'running');
      jobs.length = 0;
      jobs.push(...keep);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});
