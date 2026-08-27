/**
 * Runtime capability detection, and the REASON each capability is missing.
 *
 * Why this file exists: the app was tested on http://localhost, where everything
 * works, then opened on a phone at http://192.168.x.x:8000, where offline and
 * voice both silently did nothing. Both failures had the same cause and neither
 * was visible in the UI:
 *
 *   Service workers and the Web Speech API are restricted to SECURE CONTEXTS.
 *   A plain-http LAN origin is not one. `'serviceWorker' in navigator` is simply
 *   false there, and `window.webkitSpeechRecognition` is undefined -- so guards
 *   written as `if (supported) {...}` skip the feature without a word.
 *
 * A demo that claims "works offline" while quietly not registering a service
 * worker is far worse than one that says on screen why it can't. So: detect,
 * explain, and tell the user the fix.
 *
 * Secure contexts are: https://, http://localhost, http://127.0.0.1, and any
 * origin allowlisted via chrome://flags/#unsafely-treat-insecure-origin-as-secure.
 */

const SECURE = typeof window !== 'undefined' && window.isSecureContext === true;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
  typeof location !== 'undefined' ? location.hostname : '');

/** How to turn this origin into a secure context, phrased for the demo team. */
export function secureContextFix() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return [
    `This page is on ${origin || 'an insecure origin'}, which browsers do not treat `
      + 'as a secure context. Offline caching and voice input are disabled by the browser, not by this app.',
    'Fix A (best, gives a real secure context): connect the phone by USB, enable USB '
      + 'debugging, then on the laptop open chrome://inspect > Port forwarding, map '
      + '8010 to localhost:8010, and load http://localhost:8010 ON THE PHONE.',
    'Fix B (no cable): on the phone open chrome://flags/#unsafely-treat-insecure-origin-as-secure, '
      + `add ${origin}, set the flag to Enabled, and relaunch Chrome.`,
  ];
}

export const caps = {
  secureContext: SECURE,
  loopback: LOOPBACK,

  /** Service worker = the offline app shell. */
  get serviceWorkerSupported() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  },
  get serviceWorkerActive() {
    return this.serviceWorkerSupported && !!navigator.serviceWorker.controller;
  },

  /** IndexedDB = the offline write queue. Works on insecure origins. */
  get indexedDB() {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  },

  get speechSupported() {
    return typeof window !== 'undefined'
      && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  /**
   * Offline CAPTURE (fill a form, score it, queue it) needs only IndexedDB and
   * the in-page JS, so it survives on an insecure origin AS LONG AS the page is
   * already loaded. Offline RELOAD needs the service worker. Keep these separate
   * -- conflating them is how the README ended up overclaiming.
   */
  get offlineCapture() { return this.indexedDB; },
  get offlineReload() { return this.serviceWorkerActive; },

  /** Reason strings, or null when the capability is fine. */
  offlineReason() {
    if (this.offlineReload) return null;
    if (!this.serviceWorkerSupported) {
      return SECURE
        ? 'This browser has no service worker support.'
        : 'Offline reload is OFF: insecure origin, so the browser blocks the service worker.';
    }
    return 'Offline reload not ready yet: service worker registered but not yet controlling '
      + 'this page. Reload once while online.';
  },

  voiceReason() {
    if (this.speechSupported) return null;
    return SECURE
      ? 'Voice input needs Chrome or Edge; this browser has no Web Speech API.'
      : 'Voice input is OFF: insecure origin, so the browser blocks the microphone API.';
  },

  /**
   * Voice needs the NETWORK even where it is supported: Chrome streams audio to
   * Google for recognition. So voice cannot work in airplane mode, ever. Demo
   * the microphone BEFORE going offline.
   */
  voiceNeedsNetwork: true,
};

/** One-line summary for the preflight screen and the console. */
export function capsSummary() {
  return {
    'Secure context': caps.secureContext,
    'Service worker supported': caps.serviceWorkerSupported,
    'Service worker controlling page': caps.serviceWorkerActive,
    'IndexedDB (offline queue)': caps.indexedDB,
    'Offline capture (score + queue)': caps.offlineCapture,
    'Offline reload (app opens with no network)': caps.offlineReload,
    'Voice input available': caps.speechSupported,
  };
}
