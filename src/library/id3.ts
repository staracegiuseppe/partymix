/** What an audio file says about itself: ID3v2 tags (MP3) or, failing that, the file name «Artista - Titolo.mp3». */
export type AudioMeta = { title?: string; artist?: string; album?: string; durationSec?: number; cover?: { mime: string; data: Uint8Array } };

export type AudioKind = 'mp3' | 'm4a' | 'ogg' | 'flac' | 'wav';
const EXT: Record<string, AudioKind> = { mp3: 'mp3', m4a: 'm4a', aac: 'm4a', mp4: 'm4a', ogg: 'ogg', oga: 'ogg', opus: 'ogg', flac: 'flac', wav: 'wav' };
export const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.ogg,.opus,.flac,.wav,audio/*';
export const extOf = (name: string) => (/\.([a-z0-9]{2,5})$/i.exec(name)?.[1] ?? '').toLowerCase();
export const kindOfName = (name: string): AudioKind | undefined => EXT[extOf(name)];

/**
 * Checks the first bytes: a file renamed to .mp3 (a picture, a web page, an empty file) is refused here,
 * before it gets into the library. Returns the real kind, or undefined when it is not audio.
 */
export function sniffAudio(b: Uint8Array): AudioKind | undefined {
  const s = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 16) return undefined;
  if (s(0, 3) === 'ID3') return mp3AfterId3(b) ? 'mp3' : undefined;
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return (b[1] & 0x18) !== 0x08 ? 'mp3' : undefined; // MPEG audio frame (or ADTS AAC, layer bits 00)
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'm4a'; // ADTS AAC
  if (s(4, 4) === 'ftyp') return 'm4a';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  return undefined;
}

const synchsafe = (b: Uint8Array, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const id3Size = (b: Uint8Array) => 10 + synchsafe(b, 6) + (b[5] & 0x10 ? 10 : 0);

/** An MP3 with tags but no sound after them is a broken download. Only checked when the bytes after the tag were read. */
function mp3AfterId3(b: Uint8Array): boolean {
  const end = id3Size(b);
  if (end + 2 > b.length) return true; // the tag is bigger than what was read: cannot tell, the player will
  for (let i = end; i < Math.min(b.length - 1, end + 4096); i++) if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) return true;
  return false;
}

function text(frame: Uint8Array): string {
  const enc = frame[0], body = frame.subarray(1);
  let s: string;
  if (enc === 1 || enc === 2) {
    let le = enc === 1;
    let start = 0;
    if (enc === 1 && body.length >= 2) {
      if (body[0] === 0xff && body[1] === 0xfe) { le = true; start = 2; } else if (body[0] === 0xfe && body[1] === 0xff) { le = false; start = 2; }
    }
    s = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(body.subarray(start));
  } else s = new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(body);
  return s.replace(/\0+$/, '').split('\0')[0].trim();
}

/** Reads title, artist, album, length and cover from an ID3v2.3/2.4 tag. Any broken byte just ends the reading. */
export function readId3(b: Uint8Array): AudioMeta {
  const out: AudioMeta = {};
  if (b.length < 10 || String.fromCharCode(b[0], b[1], b[2]) !== 'ID3') return out;
  const ver = b[3];
  if (ver < 3 || ver > 4) return out;
  const end = Math.min(b.length, 10 + synchsafe(b, 6));
  let o = 10 + (b[5] & 0x40 ? (ver === 4 ? synchsafe(b, 10) : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4) : 0);
  while (o + 10 <= end) {
    const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = ver === 4 ? synchsafe(b, o + 4) : (b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7];
    if (size <= 0 || o + 10 + size > end) break;
    const f = b.subarray(o + 10, o + 10 + size);
    try {
      if (id === 'TIT2') out.title = text(f) || out.title;
      else if (id === 'TPE1') out.artist = text(f) || out.artist;
      else if (id === 'TALB') out.album = text(f) || out.album;
      else if (id === 'TLEN') { const ms = Number(text(f)); if (ms > 0) out.durationSec = ms / 1000; }
      else if (id === 'APIC' && !out.cover) {
        const enc = f[0];
        let i = 1;
        while (i < f.length && f[i] !== 0) i++;
        const mime = new TextDecoder('latin1').decode(f.subarray(1, i)) || 'image/jpeg';
        i += 2; // terminator + picture type
        if (enc === 1 || enc === 2) { while (i + 1 < f.length && !(f[i] === 0 && f[i + 1] === 0)) i += 2; i += 2; } else { while (i < f.length && f[i] !== 0) i++; i++; }
        if (i < f.length) out.cover = { mime: mime.includes('/') ? mime : `image/${mime.toLowerCase()}`, data: f.slice(i) };
      }
    } catch { /* one bad frame: keep the others */ }
    o += 10 + size;
  }
  return out;
}

/** «01 - Artista - Titolo.mp3» → artist and title; used when the file has no tags. */
export function metaFromName(name: string, folder?: string): AudioMeta {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d{1,3}\s*[-.)]\s*/, '').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: base || name, artist: folder?.trim() || undefined };
}
