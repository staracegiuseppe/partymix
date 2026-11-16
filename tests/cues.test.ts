import { cuePoints } from '../src/cues';

const song = (head: number[], body: number, tail: number[]) => [...head, ...Array.from({ length: body }, (_, i) => 60 + (i % 5)), ...tail];

describe('mix cue points: where the music really starts and ends', () => {
  it('skips silence at the head and at the tail', () => {
    const l = song([0, 0, 0, 0, 0, 0, 0, 0], 600, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 0.25 s steps: 2 s silence, 150 s song, 2.5 s silence
    expect(cuePoints(l, 0.25)).toEqual({ start: 1.5, end: 152.5 });
  });
  it('skips a near-silent intro of a few seconds, and a long fade at the end', () => {
    const l = song(Array(24).fill(38), 600, [...Array(40).fill(36), 0, 0]); // 6 s whisper, 150 s song, 10 s fade
    const c = cuePoints(l, 0.25)!;
    expect(c.start).toBe(5.5);
    expect(c.end).toBe(156.5);
  });
  it('a soft intro longer than 20 s is the song: it is kept', () => {
    const l = song(Array(120).fill(38), 600, []); // 30 s soft intro
    expect(cuePoints(l, 0.25)!.start).toBe(0);
  });
  it('a song that starts at once is not touched', () => {
    expect(cuePoints(song([], 600, []), 0.25)).toEqual({ start: 0, end: 150 });
  });
});
