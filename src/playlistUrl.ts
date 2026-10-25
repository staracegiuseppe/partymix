export type ParsedInput =
  | { kind: 'playlist'; listId: string }
  | { kind: 'video'; videoId: string }
  | { kind: 'invalid' };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

export function parsePlaylistInput(text: string): ParsedInput {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return { kind: 'invalid' }; }
  if (!HOSTS.has(url.hostname)) return { kind: 'invalid' };
  const list = url.searchParams.get('list');
  if (list && LIST_ID.test(list)) return { kind: 'playlist', listId: list };
  const v = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') ?? '';
  if (VIDEO_ID.test(v)) return { kind: 'video', videoId: v };
  return { kind: 'invalid' };
}

/** The video id in a link, even when the link also carries a playlist id. */
export function videoIdFromUrl(text: string): string | undefined {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return undefined; }
  if (!HOSTS.has(url.hostname)) return undefined;
  const v = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') ?? '';
  return VIDEO_ID.test(v) ? v : undefined;
}
