import { describe, expect, it } from 'vitest';
import { KvBlobStore } from '../src/library/blobStore';
import { MemoryKV } from '../src/library/kv';
import { MusicLibrary } from '../src/library/library';
import { uploadErrorText } from '../src/sync/uploader';

const dl = (file: string, mime: string, size: number) => ({ id: 'lrdQydviqJE', title: 'Come mai', artist: '883', file, size, url: 'https://example.com/x', mime });

describe('audio e video dello stesso brano', () => {
  it('scaricato prima in MP3 e poi in MP4: tiene tutti e due, l’audio resta il file principale', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    await lib.addDownloaded(dl('music/Come mai.mp3', 'audio/mpeg', 6));
    expect(lib.formatOf('lrdQydviqJE')).toBe('audio');
    await lib.addDownloaded(dl('video/Come mai.mp4', 'video/mp4', 20));
    expect(lib.get('lrdQydviqJE')).toMatchObject({ file: 'music/Come mai.mp3', size: 6, videoFile: 'video/Come mai.mp4', videoSize: 20 });
    expect(lib.formatOf('lrdQydviqJE')).toBe('both');
    expect(lib.bytes()).toBe(26);
  });
  it('prima il video e poi l’audio: l’audio diventa il principale, il video resta accanto', async () => {
    const kv = new MemoryKV();
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    await lib.addDownloaded(dl('video/Come mai.mp4', 'video/mp4', 20));
    expect(lib.formatOf('lrdQydviqJE')).toBe('video');
    await lib.addDownloaded(dl('music/Come mai.mp3', 'audio/mpeg', 6));
    expect(lib.get('lrdQydviqJE')).toMatchObject({ file: 'music/Come mai.mp3', videoFile: 'video/Come mai.mp4', mime: 'audio/mpeg' });
  });
  it('una copertina che non si può più salvare: il brano si salva senza', async () => {
    const kv = new MemoryKV();
    let fail = true;
    const put = kv.put.bind(kv);
    kv.put = (async (store: string, key: string, v: unknown) => { if (fail && (v as { cover?: Blob }).cover) { fail = false; throw new DOMException('', 'UnknownError'); } return put(store as never, key, v as never); }) as typeof kv.put;
    const lib = new MusicLibrary({ kv, blobs: new KvBlobStore(kv) });
    lib.addOnline({ videoId: 'abcdefghijk', title: 'X', status: 'ok' });
    lib.get('abcdefghijk')!.cover = new Blob(['x']);
    await lib.setNasId('abcdefghijk', 'a'.repeat(64));
    expect(lib.get('abcdefghijk')?.cover).toBeUndefined();
    expect(((await kv.get('library', 'abcdefghijk')) as { nasId?: string }).nasId).toBe('a'.repeat(64));
  });
  it('gli errori senza parole dicono almeno cosa erano', () => {
    expect(uploadErrorText('No such file or directory (os error 2)').text).toMatch(/Il file non si legge: No such file/);
    expect(uploadErrorText(new DOMException('', 'UnknownError')).text).toMatch(/UnknownError/);
  });
});
