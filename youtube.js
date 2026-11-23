// YouTube ad skipper: clicks "Skip", fast-forwards ads that can't be skipped,
// closes overlay ads and hides ad slots on the page. Toggled from the popup.
(() => {
  if (window.__mediaDownloaderYT) return;
  window.__mediaDownloaderYT = true;

  const SKIP_BUTTONS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container button',
    '.videoAdUiSkipButton'
  ].join(',');

  const OVERLAY_CLOSE = '.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container';

  const HIDE_CSS = `
    ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer,
    ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer,
    ytd-companion-slot-renderer, ytd-action-companion-ad-renderer, ytd-player-legacy-desktop-watch-ads-renderer,
    ytd-statement-banner-renderer, ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer),
    ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
    #masthead-ad, #player-ads, .ytp-ad-overlay-slot, .ytp-ad-image-overlay
    { display: none !important; }`;

  let enabled = true;
  let style = null;
  let inAd = false;
  let mutedByUs = false;
  let savedRate = 1;

  function applyStyle() {
    if (enabled && !style) {
      style = document.createElement('style');
      style.id = 'media-downloader-adhide';
      style.textContent = HIDE_CSS;
      (document.head || document.documentElement).appendChild(style);
    } else if (!enabled && style) {
      style.remove();
      style = null;
    }
  }

  function visible(el) {
    return el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  }

  function countSkip() {
    try {
      chrome.storage.local.get('adsSkipped')
        .then(({ adsSkipped = 0 }) => chrome.storage.local.set({ adsSkipped: adsSkipped + 1 }))
        .catch(() => {});
    } catch { /* extension reloaded */ }
  }

  function tick() {
    if (!enabled) return;

    document.querySelectorAll(OVERLAY_CLOSE).forEach((b) => visible(b) && b.click());

    const player = document.querySelector('#movie_player.html5-video-player, .html5-video-player');
    const adShowing = !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
    const video = player && player.querySelector('video');

    if (adShowing) {
      if (!inAd) {
        inAd = true;
        countSkip();
        if (video) savedRate = video.playbackRate && video.playbackRate <= 4 ? video.playbackRate : 1;
      }
      document.querySelectorAll(SKIP_BUTTONS).forEach((b) => visible(b) && b.click());
      if (video) {
        if (!video.muted) { video.muted = true; mutedByUs = true; }
        if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) {
          video.currentTime = video.duration - 0.1;
        }
        if (video.playbackRate < 16) video.playbackRate = 16;
        if (video.paused) video.play().catch(() => {});
      }
    } else if (inAd) {
      inAd = false;
      if (video) {
        video.playbackRate = savedRate;
        if (mutedByUs) video.muted = false;
      }
      mutedByUs = false;
    }
  }

  function setEnabled(on) {
    enabled = on;
    applyStyle();
    if (!on && inAd) {
      // Hand an ad that is mid-skip back to normal playback.
      const video = document.querySelector('.html5-video-player video');
      if (video) { video.playbackRate = savedRate; if (mutedByUs) video.muted = false; }
      inAd = false;
      mutedByUs = false;
    }
  }

  try {
    chrome.storage.sync.get('skipAds').then(({ skipAds = true }) => setEnabled(skipAds)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.skipAds) setEnabled(changes.skipAds.newValue !== false);
    });
  } catch { /* extension reloaded */ }

  applyStyle();
  setInterval(tick, 250);
})();
