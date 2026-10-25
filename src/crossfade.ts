export type Profile = 'morbida' | 'standard' | 'energica' | 'manuale';

const SECONDS: Record<Profile, number | null> = { morbida: 12, standard: 8, energica: 4, manuale: null };

export function profileSeconds(p: Profile): number | null {
  return SECONDS[p];
}

/** Equal-power curve: gains in 0..1 for the outgoing and incoming deck. */
export function crossfadeGains(progress: number): { out: number; in: number } {
  const p = Math.min(1, Math.max(0, progress));
  return { out: Math.cos((p * Math.PI) / 2), in: Math.sin((p * Math.PI) / 2) };
}
