import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstLink, isAndroidApp, onSharedLink, openMusicApp } from '../src/androidBridge';

const w = window as unknown as { PartyMixAndroid?: unknown };
afterEach(() => { delete w.PartyMixAndroid; });

describe('firstLink', () => {
  it('keeps the link out of a sentence shared by an app', () => {
    expect(firstLink('Ascolta questa playlist su Spotify: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'))
      .toBe('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc');
  });
  it('returns a bare link as it is', () => {
    expect(firstLink(' https://youtube.com/playlist?list=PLabcdefghij&si=x ')).toBe('https://youtube.com/playlist?list=PLabcdefghij&si=x');
  });
  it('returns text without links trimmed', () => {
    expect(firstLink('  niente ')).toBe('niente');
  });
});

describe('bridge', () => {
  it('does nothing on desktop', () => {
    expect(isAndroidApp()).toBe(false);
    expect(openMusicApp('youtube')).toBe(false);
    const cb = vi.fn();
    onSharedLink(cb);
    window.dispatchEvent(new Event('partymix-shared'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('hands over a link shared at start-up and one shared later', () => {
    const queue = ['Guarda https://youtube.com/playlist?list=PLaaaaaaaaaa', 'https://open.spotify.com/album/xyz'];
    w.PartyMixAndroid = { takeShared: () => queue.shift() ?? null, openApp: (a: string) => a === 'spotify' };
    const cb = vi.fn();
    onSharedLink(cb);
    expect(cb).toHaveBeenLastCalledWith('https://youtube.com/playlist?list=PLaaaaaaaaaa');
    window.dispatchEvent(new Event('partymix-shared'));
    expect(cb).toHaveBeenLastCalledWith('https://open.spotify.com/album/xyz');
    window.dispatchEvent(new Event('partymix-shared'));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(openMusicApp('spotify')).toBe(true);
  });
});

import { canCast, castMessage, castStart, castState } from '../src/androidBridge';
describe('projector on a cast screen (Android)', () => {
  it('is absent on desktop', () => {
    delete (window as unknown as { PartyMixAndroid?: unknown }).PartyMixAndroid;
    expect(canCast()).toBe(false);
    expect(castStart()).toBe('none');
    expect(castState()).toBeUndefined();
  });
  it('reads the state and tells the user what to do', () => {
    (window as unknown as { PartyMixAndroid: unknown }).PartyMixAndroid = {
      takeShared: () => null, openApp: () => false,
      castState: () => JSON.stringify({ available: true, name: 'Proiettore salone', showing: true, waiting: false }),
      castStart: () => 'showing', castStop: () => {},
    };
    expect(canCast()).toBe(true);
    expect(castStart()).toBe('showing');
    expect(castMessage(castState())).toContain('Proiettore salone');
    expect(castMessage({ available: false, name: '', showing: false, waiting: true })).toContain('In attesa');
    delete (window as unknown as { PartyMixAndroid?: unknown }).PartyMixAndroid;
  });
});
