import { Channel, invoke } from '@tauri-apps/api/core';

export const hasSystemAudio = (): boolean => !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

/** 16 kHz mono blocks of what the computer is playing, as -1..1 samples. Needs the installed app. */
export async function startSystemAudio(onSamples: (s: Float32Array) => void): Promise<void> {
  const ch = new Channel<ArrayBuffer | number[]>();
  ch.onmessage = (msg) => {
    const bytes = msg instanceof ArrayBuffer ? new Uint8Array(msg) : Uint8Array.from(msg);
    const pcm = new Int16Array(bytes.slice().buffer, 0, bytes.length >> 1);
    onSamples(Float32Array.from(pcm, (v) => v / 32768));
  };
  await invoke('start_audio_capture', { onAudio: ch });
}

/** Debug aid: with PARTYMIX_ADLOG set in the environment the app appends lines to that file; asks whether it is on. */
export async function adDebug(line?: string): Promise<boolean> {
  return (await invoke('ad_debug_log', { line })) as boolean;
}

/** Debug aid: with PARTYMIX_PLAYLIST set in the environment, the playlist link to load at start. */
export async function debugPlaylist(): Promise<string | undefined> {
  return ((await invoke('ad_debug_playlist')) as string | null) ?? undefined;
}

/** Debug aid: with PARTYMIX_SPOT set in the environment, the spot mode to start with. */
export async function debugSpotMode(): Promise<string | undefined> {
  return ((await invoke('ad_debug_spot')) as string | null) ?? undefined;
}

export async function stopSystemAudio(): Promise<void> {
  await invoke('stop_audio_capture');
}
