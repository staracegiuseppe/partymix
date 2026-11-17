import { checkEnd, checkStart, cleanCue, cueLabel, cueStats, fmtCue, fmtDur, mergeCues, roundMs } from '../src/cueEdit';

describe('cue point: precision and format', () => {
  it('keeps the real currentTime, normalised to the millisecond', () => {
    expect(roundMs(37.421837)).toBe(37.422);
    expect(fmtCue(37.421837)).toBe('00:37.422');
    expect(fmtCue(228.65)).toBe('03:48.650');
    expect(fmtCue(3723.004)).toBe('1:02:03.004');
  });
});

describe('cue point: validity', () => {
  it('Start: >= 0, < duration, before End', () => {
    expect(checkStart(37.4201, 272.1)).toEqual({ ok: true, value: 37.42 });
    expect(checkStart(-1, 272).ok).toBe(false);
    expect(checkStart(272.1, 272.1).ok).toBe(false);
    expect(checkStart(200, 272, 180).ok).toBe(false);
  });
  it('End: > Start, <= duration; End before Start is refused with the message', () => {
    expect(checkEnd(228.65, 272.1, 37.42)).toEqual({ ok: true, value: 228.65 });
    const r = checkEnd(120, 272, 180);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/End point must be after Start point/);
    expect(checkEnd(300, 272).ok).toBe(false);
  });
});

describe('cue point: playlist label and statistics', () => {
  it('shows ✂ start → end, START only, or Originale', () => {
    expect(cueLabel({ startTime: 42.317, endTime: 228.65 })).toBe('✂ 00:42.317 → 03:48.650');
    expect(cueLabel({ startTime: 42.317 })).toBe('✂ START 00:42.317');
    expect(cueLabel({})).toBe('Originale');
  });
  it('original, effective and removed duration', () => {
    const s = cueStats(272, { startTime: 42, endTime: 228 });
    expect([fmtDur(s.original), fmtDur(s.effective), fmtDur(s.removed)]).toEqual(['04:32', '03:06', '01:26']);
    expect(cueStats(272, {}).removed).toBe(0);
  });
});

describe('cue point: what the mix uses', () => {
  it('the user Start/End win over the measured silence', () => {
    expect(mergeCues({ startTime: 42.317 }, { start: 3, end: 250 })).toEqual({ start: 42.317, end: 250, manualStart: true, manualEnd: false });
    expect(mergeCues({ endTime: 200 }, undefined)).toEqual({ start: 0, end: 200, manualStart: false, manualEnd: true });
    expect(mergeCues(undefined, { start: 3, end: 250 })).toEqual({ start: 3, end: 250 });
    expect(mergeCues({ startTime: 260 }, { start: 3, end: 250 })?.end).toBe(0); // a measured tail before the Start is ignored
  });
});
