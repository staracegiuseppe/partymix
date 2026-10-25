import { loadSettings } from '../settings';
import { startMic, MicResult } from './mic';
import { startVisualizer } from './visualizer';

const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
const read = () => loadSettings(store ?? ({ getItem: () => null, setItem: () => {} } as unknown as Storage));
let settings = read();
let mic: MicResult | undefined;
let msg = 'Avvio del microfono…';

const REASON: Record<string, string> = {
  denied: 'Microfono non disponibile: concedi il permesso al microfono per questa app.',
  nodevice: 'Microfono non trovato: collega un ingresso audio o sceglilo dalla console.',
  error: 'Il microfono non risponde: riprova a scegliere un ingresso dalla console.',
};

async function openMic() {
  if (mic?.ok) mic.stop();
  mic = await startMic(settings.micDeviceId);
  msg = mic.ok ? '' : REASON[mic.reason];
}

addEventListener('storage', () => {
  const prev = settings.micDeviceId;
  settings = read();
  if (prev !== settings.micDeviceId) void openMic();
});
const lyricsBox = document.createElement('div');
lyricsBox.style.cssText = 'position:fixed;left:0;right:0;bottom:7vh;text-align:center;font:600 2.2vw system-ui,sans-serif;color:#ffffffb0;text-shadow:0 2px 12px #000,0 0 3px #000;pointer-events:none;padding:0 6vw';
document.body.appendChild(lyricsBox);
function showLyrics() {
  let m: { on?: boolean; prev?: string; cur?: string; next?: string } = {};
  try { m = JSON.parse(store?.getItem('partymix.lyrics') ?? '{}'); } catch { /* ignore */ }
  lyricsBox.replaceChildren();
  if (!m.on) return;
  const row = (t: string | undefined, css: string) => { const d = document.createElement('div'); d.textContent = t ?? ''; d.style.cssText = css; return d; };
  lyricsBox.append(row(m.prev, 'opacity:.55'), row(m.cur || '♪', 'font-size:4.6vw;font-weight:800;color:#fff;margin:.2em 0'), row(m.next, 'opacity:.55'));
}
addEventListener('storage', (e) => { if (e.key === 'partymix.lyrics') showLyrics(); });
showLyrics();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

startVisualizer(
  document.getElementById('c') as HTMLCanvasElement,
  () => { const m = mic; return m && m.ok ? { spectrum: () => m.spectrum() } : undefined; },
  () => msg,
  () => read().micSensitivity,
);
void openMic();

