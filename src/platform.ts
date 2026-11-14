/**
 * Which device the app runs on. The iPhone and iPad app is the same page in a Tauri web view (WKWebView):
 * it has the Tauri bridge but not the Android one. `?ios` in the address simulates it in a browser.
 */
const tauri = (): boolean => !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
const query = (k: string): boolean => { try { return new URLSearchParams(location.search).has(k); } catch { return false; } };

/** iPadOS presents itself as a Mac: a touch screen gives it away. */
const appleTouch = (): boolean => {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
};

export const isIOSApp = (): boolean => (tauri() && appleTouch()) || query('ios');

/** iPad (or a wide simulated screen): the word used in messages. */
export const isTablet = (): boolean => /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1) || Math.min(screen.width, screen.height) >= 700;
