import { canCast, castStart, castStop } from '../androidBridge';
type TauriInternals = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
const tauri = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

export const hasNativeDisplays = () => !!tauri();

export async function listDisplays(): Promise<string[]> {
  const t = tauri();
  return t ? ((await t.invoke('list_displays')) as string[]) : [];
}

export async function openProjector(display?: string): Promise<void> {
  if (canCast()) { castStart(); return; } // Android: on the TV or projector the phone casts to
  const t = tauri();
  if (t) await t.invoke('open_projector', { display });
  else window.open('/projector.html', 'partymix-projector', 'popup,width=1280,height=720');
}

export async function closeProjector(): Promise<void> {
  if (canCast()) { castStop(); return; }
  await tauri()?.invoke('close_projector');
}

/** Reads a page through the app itself (needed for Spotify and YouTube search, which a web view may not read directly). */
export async function nativeGet(url: string): Promise<string> {
  const t = tauri();
  if (!t) throw new Error('La lettura di Spotify funziona solo nell’app installata');
  return (await t.invoke('http_get', { url })) as string;
}
