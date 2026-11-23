'use strict';

const ICONS = {
  video: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
  stream: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12a7 7 0 0 1 14 0"/><path d="M8.5 12a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="12" r="1" fill="currentColor"/><path d="M12 13v7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

const KIND_ORDER = { video: 0, audio: 1, stream: 2 };
const STAGES = {
  Merger: 'ממזג וידאו ואודיו…', FFmpegMerger: 'ממזג וידאו ואודיו…',
  ExtractAudio: 'ממיר ל-MP3…', FFmpegExtractAudio: 'ממיר ל-MP3…',
  SponsorBlock: 'מאתר קטעי חסות…', ModifyChapters: 'חותך קטעי חסות…', FFmpegModifyChapters: 'חותך קטעי חסות…'
};

const $ = (sel) => document.querySelector(sel);
let tabId = null;
let state = { title: '', hasBlob: false, items: [] };
let filter = 'all';
let yt = null;        // the YouTube video in the current tab, if any
let ytJobs = [];

// ---------- Helpers ----------

function lastSegment(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    try { return decodeURIComponent(seg); } catch { return seg; }
  } catch {
    return '';
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function displayName(item) {
  return item.filename || lastSegment(item.url) || hostOf(item.url) || item.url;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function matchesFilter(item) {
  if (filter === 'all') return true;
  if (filter === 'video') return item.kind === 'video' || item.kind === 'stream';
  return item.kind === filter;
}

function sorted(items) {
  return [...items].sort((a, b) =>
    (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) ||
    (b.size || 0) - (a.size || 0) ||
    (a.time || 0) - (b.time || 0));
}

function flash(btn, cls, html, ms = 1800) {
  const original = btn.innerHTML;
  btn.classList.add(cls);
  btn.innerHTML = html;
  setTimeout(() => { btn.classList.remove(cls); btn.innerHTML = original; }, ms);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function download(urls) {
  return chrome.runtime.sendMessage({ type: 'download', tabId, urls });
}

function youtubeVideo(url, title) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    let id = null;
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      const m = /^\/(shorts|live)\/([\w-]{6,})/.exec(u.pathname);
      if (m) id = m[2];
    } else if (host === 'youtu.be') {
      id = u.pathname.slice(1).split('/')[0];
    }
    if (!id || !/^[\w-]{6,}$/.test(id)) return null;
    return {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: (title || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube( Music)?$/, '') || 'סרטון ביוטיוב'
    };
  } catch {
    return null;
  }
}

// ---------- Generic media list ----------

function renderItem(item) {
  const li = el('li', 'item');

  const kind = el('div', `kind ${item.kind}`);
  kind.innerHTML = ICONS[item.kind] || ICONS.video;

  const info = el('div', 'info');
  const name = el('div', 'name', displayName(item));
  name.title = item.url;
  const meta = el('div', 'meta');
  meta.append(el('span', 'tag', (item.ext || item.kind).toUpperCase()));
  const parts = [];
  if (item.kind === 'stream') parts.push('פלייליסט של שידור מוזרם');
  else if (item.size) parts.push(formatSize(item.size));
  parts.push(hostOf(item.url));
  meta.append(' · ' + parts.filter(Boolean).join(' · '));
  info.append(name, meta);

  const actions = el('div', 'actions');

  const copy = el('button', 'icon-btn');
  copy.title = 'העתק קישור';
  copy.setAttribute('aria-label', 'העתק קישור');
  copy.innerHTML = ICONS.copy;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.url);
      flash(copy, 'done', ICONS.check, 1400);
    } catch { /* clipboard unavailable */ }
  });
  actions.append(copy);

  const dl = el('button', 'btn small primary');
  if (item.kind === 'stream') {
    dl.textContent = 'סטרים';
    dl.disabled = true;
    dl.title = 'זה פלייליסט של שידור מוזרם (HLS/DASH) ולא קובץ אחד. העתיקו את הקישור ופתחו אותו ב-VLC או ב-ffmpeg.';
  } else {
    dl.textContent = 'הורד';
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      try {
        const res = await download([item.url]);
        if (res && res.started) flash(dl, 'done', 'התחיל ✓');
        else { dl.title = (res && res.errors && res.errors[0]) || ''; flash(dl, 'failed', 'נכשל'); }
      } catch (e) {
        dl.title = String(e && e.message || e);
        flash(dl, 'failed', 'נכשל');
      } finally {
        setTimeout(() => { dl.disabled = false; }, 1800);
      }
    });
  }
  actions.append(dl);

  li.append(kind, info, actions);
  return li;
}

function render() {
  const items = state.items || [];
  const counts = {
    all: items.length,
    video: items.filter((i) => i.kind === 'video' || i.kind === 'stream').length,
    audio: items.filter((i) => i.kind === 'audio').length
  };
  document.querySelectorAll('.filters button').forEach((b) => {
    b.querySelector('.count').textContent = counts[b.dataset.filter] || '';
  });

  // On a YouTube video with nothing else on the page, the YouTube card is all there is.
  const onlyYouTube = !!yt && items.length === 0;
  $('#generic').hidden = onlyYouTube;

  const n = items.length;
  $('#summary').textContent = onlyYouTube ? 'סרטון ביוטיוב'
    : n === 0 ? 'לא נמצאו קבצים בעמוד' : n === 1 ? 'נמצא קובץ אחד בעמוד' : `נמצאו ${n} קבצים בעמוד`;

  const visible = sorted(items.filter(matchesFilter));
  $('#list').replaceChildren(...visible.map(renderItem));

  $('#empty').hidden = visible.length > 0;
  $('#notice').hidden = !state.hasBlob || !!yt;

  const downloadable = visible.filter((i) => i.kind !== 'stream');
  const all = $('#downloadAll');
  all.hidden = onlyYouTube;
  all.disabled = downloadable.length === 0;
  all.textContent = downloadable.length > 1 ? `הורד הכל (${downloadable.length})` : 'הורד הכל';
}

// ---------- YouTube ----------

function folderLabel(path) {
  if (!path) return 'תיקיית ההורדות';
  if (/\/Movies\/Media Downloader\/?$/.test(path)) return 'תיקיית סרטים';
  if (/\/Music\/Media Downloader\/?$/.test(path)) return 'תיקיית מוזיקה';
  if (/\/Downloads\/?$/.test(path)) return 'תיקיית ההורדות';
  return path.split('/').filter(Boolean).pop() || path;
}

function jobText(j) {
  if (j.status === 'done') return j.file ? `נשמר ב${folderLabel(j.file.slice(0, j.file.lastIndexOf('/')))}` : 'נשמר';
  if (j.status === 'cancelled') return 'בוטל';
  if (j.status === 'error') return j.error || 'ההורדה נכשלה';
  if (j.stage === 'starting') return 'מתחיל…';
  if (j.stage === 'download') {
    const what = j.mode === 'video' ? (j.part >= 2 ? 'מוריד את האודיו' : 'מוריד את הווידאו') : 'מוריד';
    return [
      `${what} ${Math.floor(j.percent || 0)}%`,
      j.speed,
      j.eta && `נותרו ${j.eta}`
    ].filter(Boolean).join(' · ');
  }
  return STAGES[j.stage] || 'מעבד את הקובץ…';
}

function renderJob(j) {
  const li = el('li', 'job');

  const top = el('div', 'job-top');
  const title = el('div', 'job-title', j.title);
  title.title = j.title;
  top.append(title, el('span', 'job-mode', j.mode === 'audio' ? 'MP3' : 'MP4'));

  const status = el('div', 'job-status' + (j.status === 'done' ? ' ok' : j.status === 'error' ? ' bad' : ''));
  status.append(el('span', 'text', jobText(j)));

  if (j.status === 'running') {
    const cancel = el('button', 'icon-btn');
    cancel.title = 'בטל';
    cancel.setAttribute('aria-label', 'בטל הורדה');
    cancel.innerHTML = ICONS.close;
    cancel.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'yt-cancel', id: j.id }));
    status.append(cancel);
  } else if (j.status === 'done' && j.file) {
    const reveal = el('button', 'link', 'הצג בתיקייה');
    reveal.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'yt-reveal', path: j.file }));
    status.append(reveal);
  }

  li.append(top, status);

  if (j.status === 'running') {
    const bar = el('div', 'bar' + (j.stage === 'download' ? '' : ' indeterminate'));
    const fill = el('i');
    fill.style.width = `${Math.max(2, j.percent || 0)}%`;
    bar.append(fill);
    li.append(bar);
  }
  return li;
}

function renderYT() {
  $('#yt').hidden = !yt && ytJobs.length === 0;
  $('#ytCurrent').hidden = !yt;
  if (yt) $('#ytTitle').textContent = yt.title;
  $('#ytJobsWrap').hidden = ytJobs.length === 0;
  $('#ytJobs').replaceChildren(...ytJobs.map(renderJob));
  $('#ytClear').hidden = !ytJobs.some((j) => j.status !== 'running');
}

function showSetup(message, isError) {
  const box = $('#ytSetup');
  box.hidden = !message;
  box.textContent = message || '';
  box.classList.toggle('error', !!isError);
}

async function checkSetup() {
  let res;
  const { ytStatus } = await chrome.storage.session.get('ytStatus');
  if (ytStatus && ytStatus.ok && Date.now() - ytStatus.time < 5 * 60 * 1000) {
    res = ytStatus;
  } else {
    showSetup('בודק את yt-dlp…');
    res = await chrome.runtime.sendMessage({ type: 'yt-check' });
    if (res && res.ok && res.status && res.status.ytdlp) {
      chrome.storage.session.set({ ytStatus: { ...res, time: Date.now() } });
    }
  }

  if (!res || !res.ok) {
    showSetup((res && res.error) || 'לא הצלחתי להתחבר ל-yt-dlp.', true);
    return;
  }
  const s = res.status || {};
  if (!s.ytdlp) {
    showSetup('yt-dlp לא מותקן במחשב. הריצו את install.sh שבתיקיית התוסף (הוראות ב-README).', true);
    return;
  }
  const v = folderLabel(s.videoDir);
  const a = folderLabel(s.audioDir);
  $('#ytWhere').textContent = v === a ? `יוטיוב · יישמר ב${v}` : `וידאו יישמר ב${v}, אודיו ב${a}`;
  const warnings = [];
  if (!s.ffmpeg) warnings.push('חסר ffmpeg: ההורדה תהיה באיכות בסיסית, בלי המרה ל-MP3 ובלי חיתוך קטעי חסות.');
  if (!s.deno) warnings.push('חסר deno: ייתכן שיוטיוב יחסום חלק מההורדות.');
  showSetup(warnings.join(' '), false);

  $('#ytVideo').disabled = false;
  $('#ytAudio').disabled = !s.ffmpeg;
  $('#ytSponsor').disabled = !s.ffmpeg;
}

async function startYT(mode, btn) {
  if (!yt) return;
  btn.disabled = true;
  const sponsorblock = $('#ytSponsor').checked && !$('#ytSponsor').disabled;
  await chrome.runtime.sendMessage({ type: 'yt-download', mode, sponsorblock, url: yt.url, videoId: yt.id, title: yt.title });
  setTimeout(() => { btn.disabled = false; }, 1200);
}

// ---------- Wiring ----------

async function init() {
  const params = new URLSearchParams(location.search);
  let tab = null;
  if (params.get('tab')) {
    tab = { id: Number(params.get('tab')), url: params.get('url') || '', title: params.get('title') || '' };
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  tabId = tab ? tab.id : null;
  yt = tab ? youtubeVideo(tab.url || '', tab.title || '') : null;

  if (tabId != null) {
    const key = 't' + tabId;
    const got = await chrome.storage.session.get([key, 'ytJobs']);
    if (got[key]) state = got[key];
    ytJobs = got.ytJobs || [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes[key]) {
        state = changes[key].newValue || { title: '', hasBlob: false, items: [] };
        render();
      }
      if (area === 'session' && changes.ytJobs) {
        ytJobs = changes.ytJobs.newValue || [];
        renderYT();
      }
      if (area === 'local' && changes.adsSkipped) showAdCount(changes.adsSkipped.newValue);
    });
  }
  render();
  renderYT();

  const sync = await chrome.storage.sync.get(['saveAs', 'skipAds', 'ytSponsor']);
  $('#saveAs').checked = !!sync.saveAs;
  $('#saveAs').addEventListener('change', (e) => chrome.storage.sync.set({ saveAs: e.target.checked }));
  $('#skipAds').checked = sync.skipAds !== false;
  $('#skipAds').addEventListener('change', (e) => chrome.storage.sync.set({ skipAds: e.target.checked }));
  $('#ytSponsor').checked = sync.ytSponsor !== false;
  $('#ytSponsor').addEventListener('change', (e) => chrome.storage.sync.set({ ytSponsor: e.target.checked }));

  const { adsSkipped = 0 } = await chrome.storage.local.get('adsSkipped');
  showAdCount(adsSkipped);

  document.querySelectorAll('.filters button').forEach((b) => {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      document.querySelectorAll('.filters button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      render();
    });
  });

  $('#downloadAll').addEventListener('click', async () => {
    const btn = $('#downloadAll');
    const urls = sorted(state.items.filter(matchesFilter))
      .filter((i) => i.kind !== 'stream')
      .map((i) => i.url);
    if (!urls.length) return;
    btn.disabled = true;
    try {
      const res = await download(urls);
      const failed = res && res.errors && res.errors.length;
      flash(btn, failed ? 'failed' : 'done', failed ? `${res.started} מתוך ${urls.length} התחילו` : 'ההורדות התחילו ✓', 2200);
    } finally {
      setTimeout(render, 2300);
    }
  });

  $('#clear').addEventListener('click', () => {
    if (tabId != null) chrome.runtime.sendMessage({ type: 'clear', tabId });
  });

  $('#ytVideo').addEventListener('click', (e) => startYT('video', e.currentTarget));
  $('#ytAudio').addEventListener('click', (e) => startYT('audio', e.currentTarget));
  $('#ytClear').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'yt-clear' }));

  if (yt) checkSetup();
}

function showAdCount(n) {
  $('#adCount').textContent = n ? `(דילגנו על ${n})` : '';
}

init();
