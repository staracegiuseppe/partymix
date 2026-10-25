import type { Track } from './queue';

/**
 * Compares the queue with the playlist as YouTube reports it now.
 * Tracks added or substituted by hand are never removed, replaced ones are not re-added,
 * and an empty answer (outage, playlist made private) changes nothing.
 */
export function diffPlaylist(queue: Track[], remoteIds: string[], replaced: Set<string>): { added: string[]; removed: string[] } {
  if (remoteIds.length === 0) return { added: [], removed: [] };
  const remote = new Set(remoteIds);
  const have = new Set(queue.map((t) => t.videoId));
  const added: string[] = [];
  for (const id of remoteIds) if (!have.has(id) && !replaced.has(id) && !added.includes(id)) added.push(id);
  const removed = queue.filter((t) => !t.manual && !remote.has(t.videoId)).map((t) => t.videoId);
  return { added, removed };
}
