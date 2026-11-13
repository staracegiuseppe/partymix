import { loadSettings } from '../settings';
import { paintWords } from '../ui/dom';
import { startMic, MicResult } from './mic';
import { startVisualizer } from './visualizer';
import { createVideoLayer, parseVideoMsg, VideoFollower, VideoStage } from './video';

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
  let m: { on?: boolean; prev?: string; cur?: string; next?: string; p?: number } = {};
  try { m = JSON.parse(store?.getItem('partymix.lyrics') ?? '{}'); } catch { /* ignore */ }
  lyricsBox.replaceChildren();
  if (!m.on || settings.projectorMode === 'video') return;
  const row = (t: string | undefined, css: string) => { const d = document.createElement('div'); d.textContent = t ?? ''; d.style.cssText = css; return d; };
  const cur = row('', 'font-size:4.6vw;font-weight:800;margin:.2em 0');
  if (m.cur && settings.lyricsHighlight) paintWords(cur, m.cur, m.p ?? 0, '#ffd23f', '#fff'); else cur.textContent = m.cur || '♪';
  lyricsBox.append(row(m.prev, 'opacity:.55'), cur, row(m.next, 'opacity:.55'));
}
addEventListener('storage', (e) => { if (e.key === 'partymix.lyrics' || e.key === 'partymix.settings') showLyrics(); });
// On Android the projector runs in its own web view on the cast screen, where change events may not arrive: look.
let seen = '';
setInterval(() => {
  const now = (store?.getItem('partymix.settings') ?? '') + (store?.getItem('partymix.lyrics') ?? '');
  if (now === seen) return;
  seen = now;
  const prev = settings.micDeviceId;
  settings = read();
  if (prev !== settings.micDeviceId) void openMic();
  showLyrics();
}, 120);

// «Video YouTube» mode: the video of the song being heard, full screen and muted, over the shapes.
// Two players take turns so the next video is already loaded when the song changes.
const boxes = [0, 1].map(() => {
  const b = document.createElement('div');
  b.style.cssText = 'position:fixed;inset:0;opacity:0;transition:opacity .5s;pointer-events:none;background:#000';
  document.body.appendChild(b);
  return b;
});
let stage: VideoStage | undefined;
let videoStarting = false;
function tickVideo() {
  if (settings.projectorMode !== 'video') {
    boxes.forEach((b) => { b.style.opacity = '0'; });
    stage?.tick(undefined);
    return;
  }
  if (!stage) {
    if (!videoStarting) {
      videoStarting = true;
      Promise.all(boxes.map((b) => createVideoLayer(b))).then((ps) => {
        stage = new VideoStage([new VideoFollower(ps[0]), new VideoFollower(ps[1])]);
        boxes.forEach((b) => { const f = b.querySelector('iframe'); if (f) f.style.cssText = 'width:100vw;height:100vh;border:0;display:block'; });
      }).catch(() => { videoStarting = false; msg = 'Non riesco ad avviare il video YouTube sul proiettore: controlla la connessione.'; });
    }
    return;
  }
  const show = stage.tick(parseVideoMsg(store?.getItem('partymix.video')));
  // the incoming picture fades in above the outgoing one
  boxes.forEach((b, i) => { b.style.opacity = show[i] ? '1' : '0'; b.style.zIndex = show[i] && !show[1 - i] ? '2' : show[i] ? '1' : '0'; });
}
setInterval(tickVideo, 250);
showLyrics();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

startVisualizer(
  document.getElementById('c') as HTMLCanvasElement,
  () => { const m = mic; return m && m.ok ? { spectrum: () => m.spectrum() } : undefined; },
  () => msg,
  () => read().micSensitivity,
);
void openMic();

