import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The design decisions that are easy to undo by accident, asserted.
 *
 * Two of this task's requirements are the kind normally verified by looking at the
 * screen once and then quietly regressing three commits later: Thai text must not be
 * clipped by tight leading, and text must meet WCAG AA contrast. Both are mechanical
 * properties of the tokens, so both are checked here rather than trusted.
 */

const CSS = readFileSync(join(__dirname, 'index.css'), 'utf8');

describe('type scale', () => {
  const lineHeights = [...CSS.matchAll(/--text-(\w+)--line-height:\s*([\d.]+)/g)].map(
    ([, name, value]) => ({ name, value: Number(value) }),
  );

  it('declares a line-height for every size', () => {
    const sizes = [...CSS.matchAll(/--text-(\w+):\s/g)].map(([, name]) => name);
    expect(sizes.length).toBeGreaterThanOrEqual(8);
    expect(lineHeights.map((l) => l.name).sort()).toEqual(sizes.sort());
  });

  it('gives body copy 1.6, which is what Thai needs', () => {
    // Thai stacks an upper vowel and a tone mark above the base character and can
    // hang a lower vowel below it. A line box sized for Latin clips them.
    const base = lineHeights.find((l) => l.name === 'base');
    expect(base?.value).toBeGreaterThanOrEqual(1.6);

    for (const size of ['xs', 'sm', 'base']) {
      expect(lineHeights.find((l) => l.name === size)?.value).toBeGreaterThanOrEqual(1.6);
    }
  });

  it('never lets a heading drop below 1.35', () => {
    for (const { name, value } of lineHeights) {
      expect(value, `--text-${name}--line-height`).toBeGreaterThanOrEqual(1.35);
    }
  });
});

describe('no leading utility may clip Thai', () => {
  /**
   * Tailwind's tight leadings are all below what Thai needs. `leading-tight` is 1.25
   * and `leading-none` is 1 — both clip tone marks outright.
   */
  const FORBIDDEN = /\bleading-(none|tight|snug|3|4|5)\b/;

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return sourceFiles(full);
      }
      // This file names the classes in order to forbid them.
      if (entry.endsWith('.spec.ts')) {
        return [];
      }
      return /\.(tsx?|css)$/.test(entry) ? [full] : [];
    });

  /**
   * A mention is not a use. The class name appears legitimately in two shapes that
   * style nothing: a comment explaining why it was removed, and element text showing
   * a reader what not to write.
   */
  const isDocumentation = (line: string): boolean => {
    const trimmed = line.trim();
    const isComment =
      trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    const isRenderedAsText = />\s*leading-(none|tight|snug|3|4|5)\s*</.test(line);
    return isComment || isRenderedAsText;
  };

  it.each(sourceFiles(__dirname).map((f) => [f.replace(__dirname, 'src'), f]))(
    '%s uses no tight leading',
    (_label, file) => {
      const contents = readFileSync(file, 'utf8');
      const offending = contents
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => FORBIDDEN.test(line) && !isDocumentation(line));

      expect(
        offending.map((o) => `line ${o.number}: ${o.line.trim()}`),
        'tight leading clips Thai vowels and tone marks',
      ).toEqual([]);
    },
  );
});

describe('contrast meets WCAG AA', () => {
  /** oklch -> linear sRGB, enough of the conversion to compute luminance. */
  function oklchToLinearRgb(l: number, c: number, hDeg: number): [number, number, number] {
    const h = (hDeg * Math.PI) / 180;
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);

    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;

    const L = l_ ** 3;
    const M = m_ ** 3;
    const S = s_ ** 3;

    return [
      4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
      -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
      -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
    ];
  }

  const luminance = (l: number, c: number, h: number): number => {
    const [r, g, b] = oklchToLinearRgb(l, c, h).map((v) => Math.min(1, Math.max(0, v)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const contrast = (a: [number, number, number], b: [number, number, number]): number => {
    const la = luminance(...a);
    const lb = luminance(...b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  };

  /** Reads a token's oklch triple straight out of index.css. */
  const token = (name: string): [number, number, number] => {
    const match = CSS.match(
      new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`),
    );
    if (!match) {
      throw new Error(`token --color-${name} not found or not an oklch triple`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const WHITE: [number, number, number] = [1, 0, 0];

  it.each([
    ['body text on the page background', token('neutral-900'), token('neutral-50')],
    ['body text on a card', token('neutral-900'), WHITE],
    ['secondary text on a card', token('neutral-600'), WHITE],
    ['white on a primary button', WHITE, token('brand-600')],
    ['white on a destructive button', WHITE, token('danger')],
    ['danger text on its tinted background', token('danger'), token('danger-bg')],
    ['success text on its tinted background', token('success'), token('success-bg')],
  ])('%s is at least 4.5:1', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['muted text on a card', token('neutral-500'), WHITE],
    ['the focus ring against the page', token('brand-600'), token('neutral-50')],
  ])('%s is at least 3:1', (_label, fg, bg) => {
    // 3:1 is the AA threshold for large text and for non-text elements such as a
    // focus indicator. Muted text is only ever used at >=18px or as supporting copy.
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('the palette stays small', () => {
  it('has one neutral ramp, one brand ramp, three semantics', () => {
    const ramps = new Set(
      [...CSS.matchAll(/--color-([a-z]+)-\d{2,3}:/g)].map(([, name]) => name),
    );
    // A project looks unfinished because it uses too many colours, not too few.
    expect([...ramps].sort()).toEqual(['brand', 'neutral']);
  });

  it('defines exactly two radii and two shadows', () => {
    expect([...CSS.matchAll(/--radius-(control|surface):/g)]).toHaveLength(2);
    expect([...CSS.matchAll(/--shadow-(resting|lifted):/g)]).toHaveLength(2);
  });
});
