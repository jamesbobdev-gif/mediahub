// Normalise every platform's remote keyCodes into one intent enum before anyone
// else sees the event. The portal never receives raw keys.

export const PLATFORM = detectPlatform();

export function detectPlatform() {
  const ua = navigator.userAgent;
  if (/Web0S|webOS/i.test(ua) || typeof window.webOS !== 'undefined' || typeof window.PalmSystem !== 'undefined') return 'webos';
  if (/Tizen/i.test(ua) || typeof window.tizen !== 'undefined') return 'tizen';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

export const KEYMAP = {
  webos:   { 38: 'up', 40: 'down', 37: 'left', 39: 'right', 13: 'select', 461: 'back', 415: 'play', 19: 'pause', 10252: 'playpause',
             417: 'ff', 412: 'rw', 403: 'mode', 404: 'menu', 405: 'cursor', 406: 'info', 33: 'prev', 34: 'next' },
  tizen:   { 38: 'up', 40: 'down', 37: 'left', 39: 'right', 13: 'select', 10009: 'back', 415: 'play', 19: 'pause', 10252: 'playpause',
             417: 'ff', 412: 'rw', 403: 'mode', 404: 'menu', 405: 'cursor', 406: 'info', 10232: 'prev', 10233: 'next' },
  android: { 19: 'up', 20: 'down', 21: 'left', 22: 'right', 23: 'select', 66: 'select', 4: 'back', 111: 'back', 126: 'play', 127: 'pause',
             85: 'playpause', 90: 'ff', 89: 'rw', 183: 'mode', 184: 'menu', 185: 'cursor', 165: 'info', 88: 'prev', 87: 'next' },
  // Desktop fallback for development: arrows, Enter, Escape/Backspace, and letters.
  desktop: { 38: 'up', 40: 'down', 37: 'left', 39: 'right', 13: 'select', 27: 'back', 8: 'back', 32: 'playpause',
             190: 'ff', 188: 'rw', 77: 'mode', 72: 'menu', 67: 'cursor', 73: 'info', 219: 'prev', 221: 'next' },
};

/** Keys that TV OSes do not deliver until an app registers them. */
export function registerPlatformKeys() {
  try {
    if (PLATFORM === 'tizen' && window.tizen?.tvinputdevice) {
      for (const k of ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaFastForward', 'MediaRewind', 'MediaTrackPrevious', 'MediaTrackNext',
                       'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', 'ChannelUp', 'ChannelDown']) {
        try { window.tizen.tvinputdevice.registerKey(k); } catch {}
      }
    }
    // webOS: colour and media keys are declared in appinfo.json ("requiredKeys"); nothing to do at runtime.
  } catch {}
}

/** Capture-phase key router. `dispatch(intent, {repeat, raw})` is called for mapped keys only. */
export function installKeyRouter(dispatch, { platform = PLATFORM } = {}) {
  const map = KEYMAP[platform] || KEYMAP.desktop;
  const onDown = (e) => {
    const intent = map[e.keyCode];
    if (!intent) return;
    e.preventDefault(); e.stopImmediatePropagation();
    dispatch(intent, { repeat: e.repeat, raw: e, t: performance.now(), phase: 'down' });
  };
  const onUp = (e) => {
    const intent = map[e.keyCode];
    if (!intent) return;
    e.preventDefault(); e.stopImmediatePropagation();
    dispatch(intent, { repeat: false, raw: e, t: performance.now(), phase: 'up' });
  };
  window.addEventListener('keydown', onDown, { capture: true });
  window.addEventListener('keyup', onUp, { capture: true });
  return () => { window.removeEventListener('keydown', onDown, { capture: true }); window.removeEventListener('keyup', onUp, { capture: true }); };
}
