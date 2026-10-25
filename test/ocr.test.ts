import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  clickPoint,
  createBackend,
  findText,
  ICON_OFFSET_LABEL_HEIGHTS,
  matchText,
  recognizeFrame,
  toScreenText,
} from '../src/ocr.js';
import { recognizeWithEscalation } from '../src/index.js';
import type { Frame, OcrBackend, RawObservation, ScreenText, WindowBounds } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/home-screen.json', import.meta.url));

const window: WindowBounds = {
  id: 42,
  owner: 'iPhone Mirroring',
  title: 'iPhone Mirroring',
  x: 100,
  y: 50,
  width: 443,
  height: 958,
};

/** A frame whose pixel size is exactly 2× the window (Retina). */
const retinaFrame: Frame = {
  image: Buffer.alloc(0),
  pixelWidth: window.width * 2,
  pixelHeight: window.height * 2,
  window,
  scale: 2,
  generation: 1,
  durationMs: 0,
};

/** A 1× frame on a window placed at a negative offset (second display). */
const offsetFrame: Frame = {
  image: Buffer.alloc(0),
  pixelWidth: 400,
  pixelHeight: 300,
  window: { id: 7, owner: 'iPhone Mirroring', title: null, x: -120, y: 200, width: 400, height: 300 },
  scale: 1,
  generation: 2,
  durationMs: 0,
};

/** Compares floats with a tolerance; coordinates are fractional by nature. */
const near = (actual: number, expected: number, label: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
};

const obs = (overrides: Partial<RawObservation> = {}): RawObservation => ({
  text: 'Settings',
  confidence: 0.9,
  x: 0,
  y: 0,
  width: 0.5,
  height: 0.1,
  ...overrides,
});

describe('toScreenText', () => {
  it('maps a normalized top-left box to absolute screen points on a 2x display', () => {
    const text = toScreenText(obs({ x: 0.1, y: 0.2, width: 0.2, height: 0.1 }), retinaFrame);

    // A normalized fraction maps to the same fraction of the window's points,
    // because the capture is exactly 2x: (0.1 * 886px) / 2 = 44.3pt.
    near(text.bounds.x, 100 + 44.3, 'x');
    near(text.bounds.y, 50 + 191.6, 'y');
    near(text.bounds.width, 88.6, 'width');
    near(text.bounds.height, 95.8, 'height');

    assert.equal(text.center.x, Math.round(100 + 44.3 + 44.3));
    assert.equal(text.center.y, Math.round(50 + 191.6 + 47.9));
  });

  it('returns integral click targets', () => {
    const text = toScreenText(obs({ x: 0.333, y: 0.777, width: 0.111, height: 0.013 }), retinaFrame);
    assert.ok(Number.isInteger(text.center.x), `x=${text.center.x}`);
    assert.ok(Number.isInteger(text.center.y), `y=${text.center.y}`);
  });

  it('keeps 1x frames unscaled and honors negative window origins', () => {
    const text = toScreenText(obs({ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }), offsetFrame);

    assert.equal(text.bounds.x, -120 + 200);
    assert.equal(text.bounds.y, 200 + 150);
    assert.equal(text.bounds.width, 40);
    assert.equal(text.bounds.height, 30);
    assert.deepEqual(text.center, { x: 100, y: 365 });
  });

  it('treats a zero top-left box as the window origin', () => {
    const text = toScreenText(obs({ x: 0, y: 0, width: 0.2, height: 0.2 }), retinaFrame);
    assert.equal(text.bounds.x, window.x);
    assert.equal(text.bounds.y, window.y);
  });

  it('clamps an overhanging box inside the window', () => {
    const text = toScreenText(obs({ x: 0.98, y: 0.98, width: 0.1, height: 0.1 }), retinaFrame);
    assert.equal(text.bounds.x, 100 + 0.98 * 443, 'raw bounds stay unclamped for diagnostics');
    assert.equal(text.center.x, window.x + window.width);
    assert.equal(text.center.y, window.y + window.height);
  });

  it('the bottom edge of the image lands on the window bottom', () => {
    const text = toScreenText(obs({ x: 0, y: 0.9, width: 0.1, height: 0.1 }), retinaFrame);
    assert.equal(text.bounds.y + text.bounds.height, window.y + window.height);
  });
});

const screenText = (text: string, confidence = 0.9, area = 100): ScreenText => ({
  text,
  confidence,
  bounds: { x: 0, y: 0, width: Math.sqrt(area), height: Math.sqrt(area) },
  center: { x: 0, y: 0 },
});

describe('matchText', () => {
  const elements = [
    screenText('Settings', 0.52, 400),
    screenText('settings', 0.98, 100),
    screenText('Messages', 0.97, 500),
    screenText('Wi-Fi Settings', 0.8, 200),
    screenText('Not Connected', 0.91, 300),
  ];

  it('defaults to exact, case-insensitive matching', () => {
    const results = matchText(elements, 'Settings');
    assert.equal(results.length, 2);
    assert.equal(results[0]?.confidence, 0.98, 'highest confidence wins');
  });

  it('honors case sensitivity when asked', () => {
    const results = matchText(elements, 'Settings', { ignoreCase: false });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.confidence, 0.52);
  });

  it('supports contains and regex modes', () => {
    assert.equal(matchText(elements, 'setting', { mode: 'contains' }).length, 3);
    assert.equal(matchText(elements, '^Wi-Fi', { mode: 'regex' }).length, 1);
    assert.equal(matchText(elements, '(', { mode: 'regex' }).length, 0, 'invalid regex matches nothing');
  });

  it('ranks by confidence then area', () => {
    const same = [screenText('OK', 0.9, 100), screenText('OK', 0.9, 900)];
    assert.equal(matchText(same, 'OK')[0]?.bounds.width, 30);
  });

  it('still ranks the confident match first', () => {
    const ranked = matchText(elements, 'Settings');
    assert.equal(ranked[0]?.confidence, 0.98);
  });

  it('matches an exact label even when OCR reported low confidence', () => {
    // A confident query against a shaky read must resolve to a hit, not to
    // "not found": low confidence means unsure glyphs, not an absent label.
    const shaky = [screenText('Wi-Fi', 0.05, 100)];
    assert.equal(findText(shaky, 'Wi-Fi')?.text, 'Wi-Fi');
    assert.equal(findText(shaky, 'Wi-Fi', { mode: 'contains' })?.text, 'Wi-Fi');
  });

  it('uses index to disambiguate repeats', () => {
    assert.equal(findText(elements, 'Settings', { index: 1 })?.confidence, 0.52);
    assert.equal(findText(elements, 'Settings', { index: 5 }), undefined);
  });

  it('returns no matches for unrelated text', () => {
    assert.deepEqual(matchText(elements, 'Bluetooth'), []);
  });

  it('matches across dash variants in normalized mode', () => {
    // Vision is inconsistent about which dash codepoint it emits, and the
    // accurate net often spaces it: all of these must match a plain "Wi-Fi".
    const variants = [
      'Wi\u002DFi', // hyphen-minus
      'Wi\u2010Fi', // hyphen
      'Wi\u2011Fi', // non-breaking hyphen
      'Wi\u2013Fi', // en dash
      'Wi\u2014Fi', // em dash
      'Wi\u2212Fi', // minus sign
      'Wi - Fi', // spaced
      'Wi- Fi', // trailing space only
    ].map((text) => screenText(text, 0.5, 100));

    for (const variant of variants) {
      assert.equal(
        findText([variant], 'Wi-Fi', { mode: 'normalized' })?.text,
        variant.text,
        `normalized should match ${JSON.stringify(variant.text)}`,
      );
    }
  });

  it('normalized mode still rejects unrelated text', () => {
    assert.equal(findText([screenText('Bluetooth', 0.5, 100)], 'Wi-Fi', { mode: 'normalized' }), undefined);
  });

  it('contains mode is the stricter comparison that dash variants break', () => {
    // Documents why `normalized` exists: an en dash is not a hyphen-minus.
    assert.equal(findText([screenText('Wi\u2013Fi', 0.5, 100)], 'Wi-Fi', { mode: 'contains' }), undefined);
  });
});

describe('recognizeFrame with the replay backend', () => {
  it('projects fixture observations onto the screen', async () => {
    const backend = createBackend({ kind: 'replay', fixturePath: fixture });
    const { texts, ocrMs } = await recognizeFrame(backend, retinaFrame, { minConfidence: 0 });

    assert.ok(ocrMs >= 0);
    assert.equal(texts.length, 5);
    assert.deepEqual(
      texts.map((t) => t.text),
      ['Settings', 'Messages', 'Settings', 'Wi-Fi', 'Not Connected'],
    );
  });

  it('drops observations below the confidence floor', async () => {
    const backend = createBackend({ kind: 'replay', fixturePath: fixture });
    const { texts } = await recognizeFrame(backend, retinaFrame, { minConfidence: 0.9 });
    assert.deepEqual(
      texts.map((t) => t.text),
      ['Settings', 'Messages', 'Wi-Fi', 'Not Connected'],
    );
  });

  it('collapses whitespace in recognized text', async () => {
    const backend = createBackend({ kind: 'replay', fixturePath: fixture });
    const { texts } = await recognizeFrame(backend, retinaFrame, { minConfidence: 0 });
    for (const text of texts) {
      assert.equal(text.text, text.text.trim());
      assert.ok(!text.text.includes('  '));
    }
  });

  it('reports a helpful error for a missing fixture', async () => {
    const backend = createBackend({ kind: 'replay', fixturePath: '/nonexistent/fixture.json' });
    await assert.rejects(
      () => recognizeFrame(backend, retinaFrame, {}),
      /cannot read fixture/,
    );
  });

  it('requires a fixture for the replay backend', () => {
    assert.throws(() => createBackend({ kind: 'replay' }), /requires a fixture/);
  });
});

describe('clickPoint', () => {
  /** A home-screen app label: 36.5pt wide, 8.5pt tall, centered in the window. */
  const label: ScreenText = {
    text: 'Settings',
    confidence: 0.9,
    bounds: { x: 248.5, y: 458.5, width: 36.5, height: 8.5 },
    center: { x: 267, y: 463 },
  };

  it('clicks the text itself by default', () => {
    assert.deepEqual(clickPoint(label), { x: 267, y: 463 });
    assert.deepEqual(clickPoint(label, { target: 'text' }), { x: 267, y: 463 });
  });

  it('clicks the icon above the label when targeting an icon', () => {
    // 4.274 label heights = 36.33pt up from a center of 463 -> 427.
    const point = clickPoint(label, { target: 'icon' });
    assert.equal(point.x, 267);
    assert.equal(point.y, Math.round(463 - ICON_OFFSET_LABEL_HEIGHTS * 8.5));
    assert.equal(point.y, 427);
  });

  it('lands on the icon for any device scale, because the ratio cancels', () => {
    // Same label rendered at different mirroring scales must resolve to the
    // same offset when expressed in label heights.
    for (const scale of [1, 0.944, 0.9077, 0.8271]) {
      const scaled: ScreenText = {
        ...label,
        bounds: { ...label.bounds, height: 8.5 * scale },
        center: { x: 267, y: Math.round(463 * scale) },
      };
      const point = clickPoint(scaled, { target: 'icon' });
      const offsetInLabelHeights = (scaled.center.y - point.y) / (8.5 * scale);
      assert.ok(
        Math.abs(offsetInLabelHeights - ICON_OFFSET_LABEL_HEIGHTS) < 0.1,
        `scale ${scale}: ratio ${offsetInLabelHeights.toFixed(2)} drifted`,
      );
    }
  });

  it('scales the icon offset with the label height', () => {
    // A 2x larger label (e.g. a 2x Display setting) sits twice as far from its icon.
    const normal = clickPoint(label, { target: 'icon' });
    const scaled = clickPoint({ ...label, bounds: { ...label.bounds, height: 17 } }, { target: 'icon' });

    const normalOffset = label.center.y - normal.y;
    const scaledOffset = label.center.y - scaled.y;
    // Rounding to whole points makes an exact 2x comparison brittle; allow 1pt.
    assert.ok(
      Math.abs(scaledOffset - 2 * normalOffset) <= 1,
      `expected ~${2 * normalOffset}pt, got ${scaledOffset}pt`,
    );
  });

  it('applies manual offsets after the icon shift', () => {
    assert.deepEqual(clickPoint(label, { target: 'icon', offsetY: -5 }), { x: 267, y: 422 });
    assert.deepEqual(clickPoint(label, { target: 'icon', offsetX: 10 }), { x: 277, y: 427 });
    assert.deepEqual(clickPoint(label, { target: 'text', offsetY: 3 }), { x: 267, y: 466 });
  });

  it('returns integral coordinates', () => {
    const point = clickPoint({ ...label, center: { x: 267.4, y: 462.6 } }, { target: 'icon' });
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
  });
});

describe('recognizeWithEscalation', () => {
  /** Records each recognition request so the retry decision is observable. */
  const stubBackend = (counts: { fast: number; accurate: number }) => {
    const calls: (boolean | undefined)[] = [];
    const backend: OcrBackend = {
      kind: 'replay',
      async recognize(_image, options) {
        const fast = options.fast === true;
        calls.push(options.fast);
        const n = fast ? counts.fast : counts.accurate;
        return Array.from({ length: n }, (_, i) => ({
          text: `box${i}`,
          confidence: 0.5,
          x: 0,
          y: i * 0.05,
          width: 0.2,
          height: 0.02,
        }));
      },
    };
    return { backend, calls };
  };

  it('re-runs accurately when a fast pass is too sparse', async () => {
    const { backend, calls } = stubBackend({ fast: 2, accurate: 9 });
    const result = await recognizeWithEscalation({
      backend,
      frame: retinaFrame,
      options: { fast: true, autoEscalate: 6 },
    });

    assert.deepEqual(calls, [true, false], 'fast first, then accurate');
    assert.equal(result.observations.length, 9, 'the accurate result wins');
  });

  it('keeps the fast result when it already found enough', async () => {
    const { backend, calls } = stubBackend({ fast: 8, accurate: 99 });
    const result = await recognizeWithEscalation({
      backend,
      frame: retinaFrame,
      options: { fast: true, autoEscalate: 6 },
    });

    assert.deepEqual(calls, [true], 'no second pass');
    assert.equal(result.observations.length, 8);
  });

  it('never re-runs when accurate recognition is already selected', async () => {
    const { backend, calls } = stubBackend({ fast: 0, accurate: 1 });
    const result = await recognizeWithEscalation({
      backend,
      frame: retinaFrame,
      options: { fast: false, autoEscalate: 6 },
    });

    assert.deepEqual(calls, [false], 'single accurate pass');
    assert.equal(result.observations.length, 1, 'a sparse accurate frame is accepted as-is');
  });

  it('defaults the escalation threshold to 6', async () => {
    const sparse = stubBackend({ fast: 5, accurate: 12 });
    await recognizeWithEscalation({ backend: sparse.backend, frame: retinaFrame, options: { fast: true } });
    assert.deepEqual(sparse.calls, [true, false], '5 < 6 escalates');

    const dense = stubBackend({ fast: 6, accurate: 12 });
    await recognizeWithEscalation({ backend: dense.backend, frame: retinaFrame, options: { fast: true } });
    assert.deepEqual(dense.calls, [true], '6 >= 6 does not');
  });

  it('reports the retry so a slow frame is explainable', async () => {
    const { backend } = stubBackend({ fast: 1, accurate: 7 });
    const logs: string[] = [];
    await recognizeWithEscalation({
      backend,
      frame: retinaFrame,
      options: { fast: true },
      log: (message) => logs.push(message),
    });
    assert.ok(logs.some((line) => line.includes('re-ran accurately')));
  });
});
