/** Bridge to the Android app (MainActivity.Bridge). Absent on desktop: every function then does nothing. */
type Bridge = { takeShared(): string | null; openApp(which: string): boolean; castState?(): string; castStart?(): string; castStop?(): void; castSettings?(): void };

const bridge = (): Bridge | undefined => (window as unknown as { PartyMixAndroid?: Bridge }).PartyMixAndroid;

export const isAndroidApp = (): boolean => bridge() !== undefined;

/** Apps share "Ascolta questa playlist: https://…": keep the first link, or the text as it is. */
export function firstLink(text: string): string {
  const m = text.match(/https?:\/\/[^\s<>"']+/);
  return (m ? m[0] : text).trim();
}

/** Opens the YouTube or Spotify app so the user can pick a playlist and share it back to PartyMix. */
export function openMusicApp(which: 'youtube' | 'spotify'): boolean {
  return bridge()?.openApp(which) ?? false;
}

/** Calls back with each link shared to PartyMix: at start-up, when one arrives while open, and when coming back to the app. */
export function onSharedLink(cb: (link: string) => void): void {
  const b = bridge();
  if (!b) return;
  const pull = () => {
    const t = b.takeShared();
    if (t) cb(firstLink(t));
  };
  window.addEventListener('partymix-shared', pull);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  pull();
}

export type CastState = { available: boolean; name: string; showing: boolean; waiting: boolean };

/** True on the Android app that can put the projector on a cast screen (TV or projector). */
export const canCast = (): boolean => typeof bridge()?.castStart === 'function';

export function castState(): CastState | undefined {
  try {
    const j = JSON.parse(bridge()?.castState?.() ?? '');
    return { available: j.available === true, name: typeof j.name === 'string' ? j.name : '', showing: j.showing === true, waiting: j.waiting === true };
  } catch {
    return undefined;
  }
}

/** Opens the projector on the cast screen, or Android's cast settings when none is connected yet. */
export const castStart = (): 'showing' | 'settings' | 'none' => {
  const r = bridge()?.castStart?.();
  return r === 'showing' || r === 'settings' ? r : 'none';
};
export const castStop = (): void => { bridge()?.castStop?.(); };

/** What to tell the user about the cast screen right now. */
export function castMessage(s: CastState | undefined): string {
  if (!s) return '';
  if (s.showing) return `📺 Proiettore in onda su «${s.name || 'schermo esterno'}».`;
  if (s.waiting) return 'In attesa della TV: nelle impostazioni «Trasmetti» / «Schermo wireless» scegli il proiettore, poi torna qui. Il proiettore si apre da solo appena è collegato.';
  if (s.available) return `Schermo pronto: «${s.name}». Premi «Apri proiettore».`;
  return '📺 «Apri proiettore» ti porta alle impostazioni «Trasmetti» / «Schermo wireless»: scegli la TV o il proiettore e il proiettore di PartyMix compare lì, mentre il telefono resta la console.';
}
