export type MicResult =
  | { ok: true; spectrum(): { data: Uint8Array; sampleRate: number }; stop(): void }
  | { ok: false; reason: 'denied' | 'nodevice' | 'error' };

export async function listInputs(): Promise<{ id: string; label: string }[]> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microfono ${i + 1}` }));
  } catch { return []; }
}

/** Opens the microphone for analysis only. Nothing is recorded or stored. */
export async function startMic(deviceId?: string): Promise<MicResult> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return { ok: false, reason: 'denied' };
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return { ok: false, reason: 'nodevice' };
    return { ok: false, reason: 'error' };
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  return {
    ok: true,
    spectrum: () => { analyser.getByteFrequencyData(data); return { data, sampleRate: ctx.sampleRate }; },
    stop: () => { stream.getTracks().forEach((t) => t.stop()); void ctx.close(); },
  };
}
