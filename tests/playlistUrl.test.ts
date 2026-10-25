import { parsePlaylistInput } from '../src/playlistUrl';

describe('parsePlaylistInput', () => {
  it('reads a playlist url', () => {
    expect(parsePlaylistInput('https://youtube.com/playlist?list=PLfBfxMb0qlFw&si=x')).toEqual({ kind: 'playlist', listId: 'PLfBfxMb0qlFw' });
  });
  it('treats watch url with list as playlist', () => {
    expect(parsePlaylistInput('https://www.youtube.com/watch?v=b2GlV6Ap-3g&list=PLfBfxMb0qlFw')).toEqual({ kind: 'playlist', listId: 'PLfBfxMb0qlFw' });
  });
  it('reads single videos from watch and youtu.be urls', () => {
    expect(parsePlaylistInput('https://www.youtube.com/watch?v=b2GlV6Ap-3g')).toEqual({ kind: 'video', videoId: 'b2GlV6Ap-3g' });
    expect(parsePlaylistInput(' https://youtu.be/b2GlV6Ap-3g?t=5 ')).toEqual({ kind: 'video', videoId: 'b2GlV6Ap-3g' });
  });
  it('rejects anything else', () => {
    for (const t of ['', 'ciao', 'https://example.com/watch?v=b2GlV6Ap-3g', 'https://youtube.com/watch?v=corto'])
      expect(parsePlaylistInput(t)).toEqual({ kind: 'invalid' });
  });
});
