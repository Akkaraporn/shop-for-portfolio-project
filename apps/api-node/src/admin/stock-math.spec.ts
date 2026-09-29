import { adjust, available, commit, release, reserve } from './stock-math';

describe('stock math', () => {
  const start = { onHand: 10, reserved: 3 };

  it('available is on hand minus reserved', () => {
    expect(available(start)).toBe(7);
  });

  it('reserve moves only reserved, and refuses more than is available', () => {
    expect(reserve(start, 7)).toEqual({
      ok: true,
      levels: { onHand: 10, reserved: 10 },
    });
    expect(reserve(start, 8).ok).toBe(false);
  });

  it('commit moves both columns by the same amount', () => {
    expect(commit(start, 3)).toEqual({
      ok: true,
      levels: { onHand: 7, reserved: 0 },
    });
    // Available is unchanged by a commit: the units were already spoken for.
    const after = commit(start, 2);
    expect(after.ok && available(after.levels)).toBe(available(start));
    expect(commit(start, 4).ok).toBe(false);
  });

  it('release gives units back without touching on hand', () => {
    expect(release(start, 3)).toEqual({
      ok: true,
      levels: { onHand: 10, reserved: 0 },
    });
    expect(release(start, 4).ok).toBe(false);
  });

  it('an adjustment may not dip below what is reserved', () => {
    expect(adjust(start, -7)).toEqual({
      ok: true,
      levels: { onHand: 3, reserved: 3 },
    });
    expect(adjust(start, -8).ok).toBe(false);
    expect(adjust(start, -999).ok).toBe(false);
    expect(adjust(start, 5)).toEqual({
      ok: true,
      levels: { onHand: 15, reserved: 3 },
    });
  });

  it('two +10 deltas both land, where two absolute writes would lose one', () => {
    const a = adjust(start, 10);
    const b = a.ok ? adjust(a.levels, 10) : a;
    expect(b.ok && b.levels.onHand).toBe(30);
  });
});
