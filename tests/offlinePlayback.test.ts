import { AudioDeck, AudioLike, HybridDeck, sourceText } from '../src/audioDeck';
import { Automix } from '../src/automix';
import { Queue, Track } from '../src/queue';
import type { YouTubeDeck } from '../src/youtubeDeck';

/** A fake <audio>: loading a link fires «loadedmetadata» (or «error» for links marked bad). */
function fakeAudio(): AudioLike & { fire(t: string): void; srcs: string[] } {
  const ls = new Map<string, Set<() => void>>();
  const a = {
    src: '', currentTime: 0, duration: 180, volume: 1, preload: '', paused: true, srcs: [] as string[],
    play: vi.fn(async () => { a.paused = false; }), pause: vi.fn(() => { a.paused = true; }),
    load: vi.fn(() => { if (a.src) { a.srcs.push(a.src); queueMicrotask(() => a.fire(a.src.includes('bad') ? 'error' : 'loadedmetadata')); } }),
    removeAttribute: vi.fn(() => { a.src = ''; }),
    addEventListener: (t: string, fn: () => void) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t)!.add(fn); },
    removeEventListener: (t: string, fn: () => void) => { ls.get(t)?.delete(fn); },
    fire: (t: string) => { for (const fn of [...(ls.get(t) ?? [])]) fn(); },
  };
  return a;
}
const ytFake = () => ({ load: vi.fn(async () => {}), play: vi.fn(), pause: vi.fn(), stop: vi.fn(), setVolume: vi.fn(), position: () => 0, duration: () => 200, onEnded: vi.fn(), onError: vi.fn(), seekTo: vi.fn(), readPlaylist: vi.fn(async () => ['a']) }) as unknown as YouTubeDeck;

const LOCAL = 'local:0011223344556677';
const local = new Set([LOCAL, 'dQw4w9WgXcQ']);
const deps = (online: { v: boolean }) => ({ localUrl: async (id: string) => (local.has(id) ? `blob:${id}` : undefined), canStream: () => online.v });

describe('hybrid deck: local file or YouTube', () => {
  it('plays a library song from the local file, with no network at all', async () => {
    const yt = ytFake();
    const a = fakeAudio();
    const d = new HybridDeck(new AudioDeck(a), deps({ v: false }), yt);
    await d.load(LOCAL);
    d.play();
    expect(a.srcs).toEqual([`blob:${LOCAL}`]);
    expect(yt.load).not.toHaveBeenCalled();
    expect(d.duration()).toBe(180);
    expect(d.videoIdForProjector()).toBe('');
  });
  it('a YouTube song with a local copy plays from the file too', async () => {
    const yt = ytFake();
    const d = new HybridDeck(new AudioDeck(fakeAudio()), deps({ v: true }), yt);
    await d.load('dQw4w9WgXcQ');
    expect(yt.load).not.toHaveBeenCalled();
    expect(d.videoIdForProjector()).toBe('dQw4w9WgXcQ');
  });
  it('projector on «Karaoke»: own file first; on «Video YouTube»: sound and video from YouTube; always said where from', async () => {
    const files: Record<string, string> = { KsfMFpWcVYx: 'asset://localhost/%2FMusic%2FPartyMix%20Library%2Fmusic%2FVasco%20Rossi%20-%20Io%20No%20%5BKsfMFpWcVYx%5D.mp3', abcdefghijk: 'asset://localhost/%2Fvideo%2FX%20%5Babcdefghijk%5D.mp4', brokenbroke: 'asset://localhost/bad.mp3' };
    const mode = { video: false }, net = { v: true };
    const yt = ytFake();
    const a = fakeAudio();
    const d = new HybridDeck(new AudioDeck(a), { localUrl: async (id) => files[id], canStream: () => net.v, preferYouTube: () => mode.video }, yt);
    // Karaoke: the MP3 on the computer
    await d.load('KsfMFpWcVYx');
    expect(yt.load).not.toHaveBeenCalled();
    expect(sourceText(d.source(), false)).toBe('💾 Audio dal tuo file MP3 sul computer');
    await d.load('abcdefghijk');
    expect(d.source()).toBe('video-file');
    // Video YouTube: the same song from YouTube, sound and picture together
    mode.video = true;
    await d.load('KsfMFpWcVYx');
    expect(yt.load).toHaveBeenCalledWith('KsfMFpWcVYx');
    expect(d.source()).toBe('youtube-video-mode');
    expect(sourceText(d.source(), true)).toContain('Audio e video da YouTube');
    // …but offline the file still plays, and the user is told the video cannot be shown
    net.v = false;
    await d.load('KsfMFpWcVYx');
    expect(d.source()).toBe('sound-file');
    expect(sourceText(d.source(), true)).toContain('niente internet');
    // a file that does not open → YouTube, said so
    net.v = true; mode.video = false;
    await d.load('brokenbroke');
    expect(sourceText(d.source(), false)).toContain('non si apre: suona da YouTube');
    await d.load('9bZkp7q19f0');
    expect(sourceText(d.source(), false)).toBe('☁ Audio e video da YouTube (internet)');
  });
  it('mode change mid-song (user rule): to Karaoke → the file from the beginning; to Video → YouTube leads, same point', async () => {
    const files: Record<string, string> = { KsfMFpWcVYx: 'asset://localhost/Io%20No%20%5BKsfMFpWcVYx%5D.mp3' };
    const mode = { video: true };
    const yt = ytFake();
    const a = fakeAudio();
    const audio = new AudioDeck(a);
    const seek = vi.spyOn(audio, 'seekTo');
    const d = new HybridDeck(audio, { localUrl: async (id) => files[id], canStream: () => true, preferYouTube: () => mode.video }, yt);
    await d.load('KsfMFpWcVYx'); d.setVolume(70); d.play();
    expect(d.source()).toBe('youtube-video-mode');
    expect(await d.reselect()).toBe(false); // already right
    mode.video = false;
    expect(await d.reselect()).toBe('file-from-start');
    expect(d.source()).toBe('sound-file');
    expect(seek).toHaveBeenLastCalledWith(0);
    expect((a as unknown as { paused: boolean }).paused).toBe(false);
    expect(yt.stop).toHaveBeenCalled();
    mode.video = true;
    expect(await d.reselect()).toBe('youtube');
    expect(d.source()).toBe('youtube-video-mode');
    expect(yt.play).toHaveBeenCalled();
    expect(yt.setVolume).toHaveBeenLastCalledWith(70);
    // a song that is not on the computer: Karaoke restarts it on YouTube
    await d.load('9bZkp7q19f0'); d.play();
    mode.video = false;
    expect(await d.reselect()).toBe('from-start');
    expect(yt.seekTo).toHaveBeenLastCalledWith(0);
  });
  it('online: a song without a local copy goes to YouTube', async () => {
    const yt = ytFake();
    const d = new HybridDeck(new AudioDeck(fakeAudio()), deps({ v: true }), yt);
    await d.load('9bZkp7q19f0');
    expect(yt.load).toHaveBeenCalledWith('9bZkp7q19f0');
  });
  it('offline: an online-only song is refused at once (kind «offline»), YouTube is not even tried', async () => {
    const yt = ytFake();
    const d = new HybridDeck(new AudioDeck(fakeAudio()), deps({ v: false }), yt);
    await expect(d.load('9bZkp7q19f0')).rejects.toMatchObject({ kind: 'offline' });
    expect(yt.load).not.toHaveBeenCalled();
  });
  it('works before YouTube is ready (app started without network)', async () => {
    const d = new HybridDeck(new AudioDeck(fakeAudio()), deps({ v: false }));
    await d.load(LOCAL);
    await expect(d.load('9bZkp7q19f0')).rejects.toMatchObject({ kind: 'offline' });
    await expect(d.readPlaylist('PL1')).rejects.toThrow(/YouTube non è raggiungibile/);
  });
  it('a missing local file is unplayable; a corrupt one too', async () => {
    const d = new HybridDeck(new AudioDeck(fakeAudio()), { localUrl: async (id) => (id.endsWith('bad') ? 'blob:bad' : undefined), canStream: () => true }, ytFake());
    await expect(d.load('local:ffffffffffffffff')).rejects.toMatchObject({ kind: 'unplayable' });
    await expect(d.load('local:aaaaaaaaaaaaabad')).rejects.toMatchObject({ kind: 'unplayable' });
  });
});

describe('offline queue', () => {
  const t = (id: string): Track => ({ videoId: id, title: id, status: 'ok' });
  it('skips online-only songs without marking them broken, and plays them again when the network is back', () => {
    let online = false;
    const q = new Queue([t('yt-aaaaaaa'), t(LOCAL), t('yt-bbbbbbb'), t('local:8899aabbccddeeff')], { available: (x) => online || x.videoId.startsWith('local:') });
    expect(q.current()?.videoId).toBe(LOCAL);
    expect(q.peekNext()?.videoId).toBe('local:8899aabbccddeeff');
    expect(q.all().every((x) => x.status === 'ok')).toBe(true);
    online = true;
    q.touch();
    expect(q.peekNext()?.videoId).toBe('yt-bbbbbbb');
  });
  it('nothing playable at start (YouTube still loading): once it is ready the queue has a current song again', () => {
    let ready = false;
    const q = new Queue([t('yt-aaaaaaa'), t('yt-bbbbbbb')], { available: () => ready });
    expect(q.current()).toBeUndefined();
    ready = true;
    q.touch();
    expect(q.current()?.videoId).toBe('yt-aaaaaaa');
  });
  it('the automix keeps the party going on local songs when the network drops, without retrying the online ones', async () => {
    let online = true;
    const timers: (() => void)[] = [];
    const mk = () => new HybridDeck(new AudioDeck(fakeAudio()), { localUrl: async (id) => (id.startsWith('local:') ? `blob:${id}` : undefined), canStream: () => online }, ytFake());
    const decks: [HybridDeck, HybridDeck] = [mk(), mk()];
    const q = new Queue([t('local:0000000000000001'), t('9bZkp7q19f0'), t('local:0000000000000002')], { available: (x) => online || x.videoId.startsWith('local:') });
    const am = new Automix({ decks, queue: q, profile: () => 'standard', masterVolume: () => 80, now: () => 0, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, log: vi.fn() as never, online: () => online });
    online = false;
    q.touch();
    am.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(decks[0].currentVideoId()).toBe('local:0000000000000001');
    await new Promise((r) => setTimeout(r, 10));
    expect(decks[1].currentVideoId()).toBe('local:0000000000000002'); // the online song in between is skipped
    expect(q.all()[1].status).toBe('ok'); // …not marked broken
  });
});

describe('downloaded songs: local first, internet if the file does not play', () => {
  it('a YouTube song whose local file fails falls back to YouTube (not marked broken)', async () => {
    const yt = ytFake();
    const d = new HybridDeck(new AudioDeck(fakeAudio()), { localUrl: async () => 'blob:bad-file', canStream: () => true }, yt);
    await d.load('dQw4w9WgXcQ');
    expect(yt.load).toHaveBeenCalledWith('dQw4w9WgXcQ');
    expect(d.videoIdForProjector()).toBe('dQw4w9WgXcQ');
  });
  it('offline and the file fails: the error is reported (no network to fall back to)', async () => {
    const d = new HybridDeck(new AudioDeck(fakeAudio()), { localUrl: async () => 'blob:bad-file', canStream: () => false }, ytFake());
    await expect(d.load('dQw4w9WgXcQ')).rejects.toMatchObject({ kind: 'unplayable' });
  });
  it('a downloaded song with a good file never touches YouTube', async () => {
    const yt = ytFake();
    const d = new HybridDeck(new AudioDeck(fakeAudio()), { localUrl: async () => 'asset://localhost/x.mp4', canStream: () => true }, yt);
    await d.load('dQw4w9WgXcQ');
    expect(yt.load).not.toHaveBeenCalled();
  });
});
