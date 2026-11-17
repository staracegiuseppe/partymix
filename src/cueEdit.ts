/**
 * Cue point scelti dall'utente per un brano della playlist: da dove parte (`startTime`) e dove finisce (`endTime`),
 * in secondi con precisione al millisecondo. Il file non si tocca mai: sono solo due numeri sulla riga della playlist,
 * salvati sul dispositivo e sincronizzati col NAS come il resto della playlist.
 */
export type UserCue = { startTime?: number; endTime?: number };

/** Il valore vero di currentTime, normalizzato al millisecondo (37.421837 → 37.422). */
export const roundMs = (s: number) => Math.round(s * 1000) / 1000;

/** 37.422 → «00:37.422»; oltre l'ora «1:02:03.004». */
export function fmtCue(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), sec = Math.floor((ms % 60_000) / 1000), r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${h ? `${h}:` : ''}${p(m)}:${p(sec)}.${p(r, 3)}`;
}

export type CueCheck = { ok: true; value: number } | { ok: false; error: string };

/** startTime >= 0, < durata e prima della fine già scelta. */
export function checkStart(t: number, duration: number, end?: number): CueCheck {
  if (!Number.isFinite(t) || t < 0) return { ok: false, error: '⚠ Posizione non valida' };
  const v = roundMs(t);
  if (duration > 0 && v >= duration) return { ok: false, error: '⚠ Lo Start deve essere prima della fine del brano' };
  if (end !== undefined && v >= end) return { ok: false, error: '⚠ Lo Start deve essere prima dell’End (premi Reset o sposta l’End)' };
  return { ok: true, value: v };
}

/** endTime > startTime e <= durata. */
export function checkEnd(t: number, duration: number, start?: number): CueCheck {
  if (!Number.isFinite(t) || t <= 0) return { ok: false, error: '⚠ Posizione non valida' };
  const v = roundMs(t);
  if (duration > 0 && v > roundMs(duration)) return { ok: false, error: '⚠ L’End non può superare la durata del brano' };
  if (v <= (start ?? 0)) return { ok: false, error: '⚠ End point must be after Start point — l’End deve venire dopo lo Start' };
  return { ok: true, value: v };
}

/** Come appare il brano nella playlist: «✂ 00:42.317 → 03:48.650», «✂ START 00:42.317», «✂ END 03:48.650» o «Originale». */
export function cueLabel(c: UserCue): string {
  const s = c.startTime, e = c.endTime;
  if (s !== undefined && e !== undefined) return `✂ ${fmtCue(s)} → ${fmtCue(e)}`;
  if (s !== undefined) return `✂ START ${fmtCue(s)}`;
  if (e !== undefined) return `✂ END ${fmtCue(e)}`;
  return 'Originale';
}

export const hasCue = (c: UserCue) => c.startTime !== undefined || c.endTime !== undefined;

/** Durata originale, quella che si sente davvero e quella tolta (secondi). */
export function cueStats(duration: number, c: UserCue): { original: number; effective: number; removed: number } {
  const d = Math.max(0, duration || 0);
  const s = Math.min(d, Math.max(0, c.startTime ?? 0));
  const e = Math.min(d, c.endTime ?? d);
  const effective = Math.max(0, e - s);
  return { original: d, effective, removed: Math.max(0, d - effective) };
}

/** «04:32» (statistiche: ai secondi). */
export function fmtDur(s: number): string {
  const t = Math.round(Math.max(0, s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Valore accettabile per un cue arrivato da fuori (file salvato, NAS): numero finito, >= 0, al millisecondo. */
export function cleanCue(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 86_400 * 7 ? roundMs(x) : undefined;
}

export type MixCues = { start: number; end: number; manualStart?: boolean; manualEnd?: boolean };

/**
 * I punti che usa il mix: quelli scelti dall'utente vincono su quelli misurati dal volume del file
 * (silenzio iniziale/finale). `end` 0 = nessuna fine anticipata.
 */
export function mergeCues(user: UserCue | undefined, auto: { start: number; end: number } | undefined): MixCues | undefined {
  const us = user?.startTime, ue = user?.endTime;
  if (us === undefined && ue === undefined) return auto;
  const start = us ?? auto?.start ?? 0;
  let end = ue ?? auto?.end ?? 0;
  if (ue === undefined && end <= start) end = 0; // a measured tail before the chosen start means nothing
  return { start, end, manualStart: us !== undefined, manualEnd: ue !== undefined };
}
