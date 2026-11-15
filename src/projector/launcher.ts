import { canCast, castStart, castStop } from '../androidBridge';
import { isIOSApp } from '../platform';

/**
 * iPhone and iPad: one window, no cast API. The projector covers the app inside it and reaches the TV through
 * AirPlay «Duplica schermo»; a corner button brings back the console. It reads the same settings and
 * lyrics from localStorage as the projector window on a computer.
 */
function iosProjector(open: boolean): void {
  document.getElementById('ios-projector')?.remove();
  if (!open) return;
  const wrap = document.createElement('div');
  wrap.id = 'ios-projector';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:100;background:#000';
  const frame = document.createElement('iframe');
  frame.src = '/projector.html';
  frame.allow = 'microphone; autoplay; fullscreen';
  frame.style.cssText = 'border:0;width:100%;height:100%';
  const back = document.createElement('button');
  back.textContent = '✕ Torna alla console';
  back.setAttribute('aria-label', 'Chiudi il proiettore e torna alla console');
  back.style.cssText = 'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;cursor:pointer;white-space:nowrap;position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);right:calc(env(safe-area-inset-right,0px) + 8px);min-height:44px;padding:0 16px;border-radius:22px;border:0;background:#0009;color:#fff;font:500 14px system-ui,sans-serif;opacity:.55';
  back.onclick = () => iosProjector(false);
  wrap.append(frame, back);
  document.body.appendChild(wrap);
}
type TauriInternals = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
const tauri = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

export const hasNativeDisplays = () => !!tauri();

/** A screen: `key` is the system's id, `label` its readable name («Mi TV · 1360×768»). */
export type DisplayInfo = { key: string; label: string };

export async function listDisplays(): Promise<DisplayInfo[]> {
  const t = tauri();
  if (!t) return [];
  const r = (await t.invoke('list_displays')) as (DisplayInfo | string)[];
  return r.map((d) => (typeof d === 'string' ? { key: d, label: d } : d)); // older app versions answered plain names
}

export async function openProjector(display?: string, label?: string): Promise<void> {
  if (canCast()) { castStart(); return; } // Android: on the TV or projector the phone casts to
  if (isIOSApp()) { iosProjector(true); return; }
  const t = tauri();
  if (t) await t.invoke('open_projector', { display, label });
  else window.open('/projector.html', 'partymix-projector', 'popup,width=1280,height=720');
}

export async function closeProjector(): Promise<void> {
  if (canCast()) { castStop(); return; }
  if (isIOSApp()) { iosProjector(false); return; }
  await tauri()?.invoke('close_projector');
}

/** Reads a page through the app itself (needed for Spotify and YouTube search, which a web view may not read directly). */
export async function nativeGet(url: string): Promise<string> {
  const t = tauri();
  if (!t) throw new Error('La lettura di Spotify funziona solo nell’app installata');
  return (await t.invoke('http_get', { url })) as string;
}
