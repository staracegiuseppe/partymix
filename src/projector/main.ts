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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

startVisualizer(
  document.getElementById('c') as HTMLCanvasElement,
  () => { const m = mic; return m && m.ok ? { spectrum: () => m.spectrum() } : undefined; },
  () => msg,
  () => read().micSensitivity,
);
void openMic();

if (import.meta.env.VITE_BEACON) void import('../selftest').then((m) => setTimeout(() => m.beacon('projector page: ' + (msg || 'mic ok')), 3000));
