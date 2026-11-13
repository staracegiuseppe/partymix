import { afterEach, describe, expect, it, vi } from 'vitest';
import { showInfo, startTour, startWizard, WizardCtx } from '../src/ui/guide';

afterEach(() => { document.body.replaceChildren(); });
const btn = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe('tutorial', () => {
  it('walks through the steps with Next and Back, skipping parts that are not on screen', async () => {
    const a = document.createElement('div'), b = document.createElement('div');
    document.body.append(a, b);
    Element.prototype.scrollIntoView = vi.fn();
    const done = startTour([
      { target: () => a, title: 'Primo', text: 'uno' },
      { target: () => null, title: 'Assente', text: 'xx' },
      { target: () => b, title: 'Secondo', text: 'due' },
    ]);
    expect(document.querySelector('.tour-title')!.textContent).toBe('Primo');
    expect(document.querySelector('.tour-count')!.textContent).toBe('1 di 2');
    expect(btn('Indietro')!.disabled).toBe(true);
    btn('Avanti')!.click();
    expect(document.querySelector('.tour-title')!.textContent).toBe('Secondo');
    expect(btn('Fine')).toBeTruthy();
    btn('Indietro')!.click();
    expect(document.querySelector('.tour-title')!.textContent).toBe('Primo');
    btn('Avanti')!.click();
    btn('Fine')!.click();
    await done;
    expect(document.querySelector('.tour-card')).toBeNull();
  });
  it('can be left at any moment', async () => {
    const a = document.createElement('div');
    document.body.append(a);
    const done = startTour([{ target: () => a, title: 'x', text: 'y' }, { target: () => a, title: 'z', text: 'w' }]);
    btn('Esci dal tutorial')!.click();
    await done;
    expect(document.querySelector('.tour-hole')).toBeNull();
  });
});

const ctx = (over: Partial<WizardCtx> = {}): WizardCtx => ({
  loadPlaylist: vi.fn(), onStatus: () => () => {}, currentLink: () => '', openProjector: async () => {}, closeProjector: () => {},
  refreshInputs: async () => [], setMic: vi.fn(), currentProfile: () => 'standard', setProfile: vi.fn(),
  canStart: () => true, start: vi.fn(), openTutorial: vi.fn(), finished: vi.fn(), ...over,
});

describe('guided setup', () => {
  it('goes through all the steps, applies the chosen style and starts the party', () => {
    const c = ctx();
    startWizard(c);
    expect(document.querySelector('.wizard h2')!.textContent).toContain('Benvenuto');
    btn('Iniziamo')!.click();
    expect(document.querySelector('.wizard h2')!.textContent).toContain('1.');
    (document.querySelector('.wizard input') as HTMLInputElement).value = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
    btn('Carica playlist')!.click();
    expect(c.loadPlaylist).toHaveBeenCalledWith('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    btn('Avanti')!.click();
    expect(document.querySelector('.wizard h2')!.textContent).toContain('2.');
    btn('Avanti')!.click();
    expect(document.querySelector('.wizard h2')!.textContent).toContain('3.');
    btn('Energica')!.click();
    expect(c.setProfile).toHaveBeenCalledWith('energica');
    btn('Avanti')!.click();
    expect(document.querySelector('.wizard h2')!.textContent).toContain('pronto');
    btn('▶ Avvia l’automix')!.click();
    expect(c.start).toHaveBeenCalled();
    expect(c.finished).toHaveBeenCalled();
    expect(document.querySelector('.wizard')).toBeNull();
  });
  it('can be skipped, and counts as done', () => {
    const c = ctx();
    startWizard(c);
    btn('Salta la configurazione')!.click();
    expect(c.finished).toHaveBeenCalled();
    expect(document.querySelector('.modal')).toBeNull();
  });
  it('does not offer to start when no playlist is loaded', () => {
    startWizard(ctx({ canStart: () => false }));
    btn('Iniziamo')!.click(); btn('Avanti')!.click(); btn('Avanti')!.click(); btn('Avanti')!.click();
    expect((btn('▶ Avvia l’automix') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('info window', () => {
  it('shows the credits and the PayPal QR code to scan', () => {
    showInfo({ openTutorial: vi.fn(), openWizard: vi.fn() });
    expect(document.body.textContent).toContain('Giuseppe Starace');
    const qr = document.querySelector('img.paypal-qr') as HTMLImageElement;
    expect(qr).toBeTruthy();
    expect(qr.alt).toContain('PayPal');
    expect(document.body.textContent).toContain('Scansiona');
  });
  it('closes with the button and opens the tutorial or the setup on request', () => {
    const t = vi.fn(), w = vi.fn();
    showInfo({ openTutorial: t, openWizard: w });
    btn('Tutorial')!.click();
    expect(t).toHaveBeenCalled();
    expect(document.querySelector('.modal')).toBeNull();
    showInfo({ openTutorial: t, openWizard: w });
    btn('Configurazione guidata')!.click();
    expect(w).toHaveBeenCalled();
    showInfo({ openTutorial: t, openWizard: w });
    btn('Chiudi')!.click();
    expect(document.querySelector('.modal')).toBeNull();
  });
});
