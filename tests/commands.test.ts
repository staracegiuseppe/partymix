import { EXAMPLES, isCommand, parseCommand } from '../src/commands/parse';

describe('commands in Italian (no AI)', () => {
  it('the user’s sentence: Just Dance, liked by young people, danceable, into my playlist', () => {
    const c = parseCommand('vai su youtube, cercami i video di justdance che piacciono di più ai giovani e sono ballabili ed aggiungili alla mia playlist')!;
    expect(c.action).toBe('add');
    expect(c.query).toBe('just dance');
    expect(c.target).toBe('current');
    expect(c.sort).toBe('views');
    expect(c.recentYears).toBe(3);
    expect(c.dance).toBe(true);
    expect(c.count).toBe(15);
    expect(c.understood).toEqual(['cerca «just dance» su YouTube', 'i più visti', 'degli ultimi 3 anni', 'ballabili', '15 brani', 'aggiungi alla playlist in uso']);
  });
  it('add N to a named playlist (capitals kept), with lyrics', () => {
    const c = parseCommand('aggiungi 15 successi di Max Pezzali con testo a Karaoke')!;
    expect(c).toMatchObject({ action: 'add', target: 'Karaoke', count: 15, sort: 'views', lyrics: true });
    expect(c.query).toBe('Max Pezzali testo');
  });
  it('quoted playlist names and «nella playlist»', () => {
    expect(parseCommand('metti i video di Ed Sheeran nella playlist "Festa di Marco"')).toMatchObject({ action: 'add', target: 'Festa di Marco', query: 'Ed Sheeran' });
    expect(parseCommand('aggiungi Coldplay nella playlist Aperitivo')).toMatchObject({ action: 'add', target: 'Aperitivo', query: 'Coldplay' });
  });
  it('queue, decade, karaoke', () => {
    const c = parseCommand('metti in coda 10 canzoni anni 80 da cantare')!;
    expect(c).toMatchObject({ action: 'queue', count: 10, karaoke: true, target: undefined });
    expect(c.query).toBe('anni 80 karaoke');
  });
  it('create a playlist with songs', () => {
    const c = parseCommand('crea la playlist Matrimonio con 20 canzoni d’amore italiane più famose')!;
    expect(c).toMatchObject({ action: 'create', target: 'Matrimonio', count: 20, sort: 'views' });
    expect(c.query).toBe('d’amore italiane');
  });
  it('play now, play next, library', () => {
    expect(parseCommand('suona Vasco Rossi Albachiara')).toMatchObject({ action: 'play', query: 'Vasco Rossi Albachiara', count: 1 });
    expect(parseCommand('subito dopo Gloria Gaynor I Will Survive')).toMatchObject({ action: 'next', query: 'Gloria Gaynor I Will Survive' });
    expect(parseCommand('cerca nella mia musica Jovanotti')).toMatchObject({ action: 'search', library: true, query: 'Jovanotti' });
  });
  it('numbers in words, «di quest’anno», «più votati»', () => {
    expect(parseCommand('dieci brani reggaeton di quest’anno più votati')).toMatchObject({ count: 10, recentYears: 1, sort: 'likes', query: 'reggaeton' });
  });
  it('plain words stay a plain search', () => {
    const c = parseCommand('The Weeknd Blinding Lights')!;
    expect(c).toMatchObject({ action: 'search', query: 'The Weeknd Blinding Lights' });
    expect(isCommand(c)).toBe(false);
    expect(parseCommand('   ')).toBeUndefined();
  });
  it('every example shown in the app is understood as a command', () => {
    for (const e of EXAMPLES) {
      const c = parseCommand(e)!;
      expect(isCommand(c), e).toBe(true);
      expect(c.query.length, e).toBeGreaterThan(1);
    }
  });
});

import { introEnd } from '../src/lyrics';
describe('music video intro before the song (timed lyrics follow the record)', () => {
  // the real loudness of «Vita spericolata (Official Video)», one value a second: 29 s of film, a gap, then the song
  const vasco = [42, 54, 60, 63, 66, 67, 67, 68, 63, 63, 63, 64, 64, 63, 64, 63, 62, 62, 62, 62, 62, 62, 62, 61, 62, 61, 60, 58, 53, 40, 54, 57, 57, 57, 57, 58, 58, 58, 57, 57, 58, 57, 60, 59, 59, 61, 60, 59, 67, 63, 65, 63, 64, 64, 61, 59, 59, 67, 63, 65];
  it('finds where the song starts after the scene', () => {
    expect(introEnd(vasco, 1, 33 + 6)).toBe(30);
  });
  it('no gap → nothing moved (the extra time may be at the end)', () => {
    expect(introEnd(vasco.map((v) => Math.max(v, 55)), 1, 39)).toBeUndefined();
  });
});
