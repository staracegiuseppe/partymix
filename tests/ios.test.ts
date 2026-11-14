import { isIOSApp } from '../src/platform';
import { materialUI } from '../src/ui/material';
import { hasSystemAudio } from '../src/systemAudio';
import { openProjector, closeProjector } from '../src/projector/launcher';

const setUA = (ua: string, touch = 5) => {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: touch, configurable: true });
};
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const w = window as unknown as { __TAURI_INTERNALS__?: unknown };

describe('iPhone and iPad app', () => {
  const ua = navigator.userAgent;
  afterEach(() => { delete w.__TAURI_INTERNALS__; setUA(ua, 0); history.replaceState(null, '', '/'); document.body.innerHTML = ''; });

  it('is recognised inside the app on iPhone and on iPad (which presents itself as a Mac with a touch screen), not in Safari', () => {
    setUA(IPHONE);
    expect(isIOSApp()).toBe(false); // Safari: no Tauri bridge
    w.__TAURI_INTERNALS__ = {};
    expect(isIOSApp()).toBe(true);
    setUA(IPAD, 5);
    expect(isIOSApp()).toBe(true);
    setUA(IPAD, 0); // a real Mac
    expect(isIOSApp()).toBe(false);
  });

  it('uses the phone layout (Material) and keeps the ad detector off: iOS cannot record what the device plays', () => {
    setUA(IPHONE);
    w.__TAURI_INTERNALS__ = {};
    expect(materialUI()).toBe(true);
    expect(hasSystemAudio()).toBe(false);
    setUA(IPAD, 0);
    expect(hasSystemAudio()).toBe(true); // the Mac app still listens
  });

  it('shows the projector full screen over the app (for AirPlay) and closes it from its own button', async () => {
    history.replaceState(null, '', '/?ios');
    await openProjector();
    const p = document.getElementById('ios-projector')!;
    expect(p.querySelector('iframe')!.getAttribute('src')).toBe('/projector.html');
    p.querySelector('button')!.click();
    expect(document.getElementById('ios-projector')).toBeNull();
    await openProjector();
    await closeProjector();
    expect(document.getElementById('ios-projector')).toBeNull();
  });
});

describe('App Store rules on iPhone and iPad', () => {
  afterEach(() => { history.replaceState(null, '', '/'); document.body.innerHTML = ''; });
  it('shows no PayPal donation inside the iOS app (elsewhere it stays)', async () => {
    const { showInfo } = await import('../src/ui/guide');
    const ctx = { openTutorial: () => {}, openWizard: () => {} };
    showInfo(ctx as never);
    expect(document.querySelector('.paypal-qr')).not.toBeNull();
    document.body.innerHTML = '';
    history.replaceState(null, '', '/?ios');
    showInfo(ctx as never);
    expect(document.querySelector('.paypal-qr')).toBeNull();
    expect(document.body.textContent).not.toMatch(/PayPal|donazione/);
  });
});
