/**
 * Service-worker registration.
 *
 * A separate classic script, not part of the module graph, for two reasons:
 *
 *   1. A parse error anywhere in js/app.js must not take the offline capability
 *      down with it. This file runs on its own.
 *   2. It used to be an inline <script> in index.html, which the
 *      Content-Security-Policy the server now sends does not allow. `script-src
 *      'self'` with no 'unsafe-inline' is the header that makes an injected
 *      <script> inert, and buying that protection means every script the app runs
 *      has to be a real file. This is that file.
 *
 * NOTE the else-branch. This was once a bare `if ('serviceWorker' in navigator)`
 * with no else, so on a plain-http LAN origin -- where the property does not
 * exist at all -- the app skipped registration in complete silence and still
 * looked offline-capable. It isn't. Log it loudly; the UI banner is driven
 * separately from js/capability.js.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.info('[nirogya] service worker registered — offline reload available'))
      .catch((e) => console.error('[nirogya] SW registration FAILED, offline reload unavailable:', e));
  });
  // Re-render the banner the moment the worker takes control.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.dispatchEvent(new Event('online'));
  });
} else {
  console.error(
    '[nirogya] navigator.serviceWorker is UNAVAILABLE — offline reload will NOT work.\n'
    + 'Cause: this page is not a secure context (origin ' + location.origin + ').\n'
    + 'Fix: load over https, or http://localhost via chrome://inspect port forwarding,\n'
    + 'or allowlist this origin in chrome://flags/#unsafely-treat-insecure-origin-as-secure.');
}
