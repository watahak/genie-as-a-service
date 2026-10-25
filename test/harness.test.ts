import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultOptions, parseArgs } from '../src/config.js';
import { findText } from '../src/ocr.js';
import { toScreenText } from '../src/ocr.js';
import type { Frame, RawObservation, WindowBounds } from '../src/types.js';

const window: WindowBounds = { id: 9, owner: 'iPhone Mirroring', title: null, x: 200, y: 100, width: 400, height: 800 };

const frame = (scale: number): Frame => ({
  image: Buffer.alloc(0),
  pixelWidth: window.width * scale,
  pixelHeight: window.height * scale,
  window,
  scale,
  generation: 1,
  durationMs: 0,
});

/** The fixture's "Settings" icon, then located on screen and selected. */
const settingsIcon: RawObservation = {
  text: 'Settings',
  confidence: 0.98,
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.04,
};

describe('end-to-end coordinate flow (replay style)', () => {
  it('computes the click point a harness would use on Retina', () => {
    const text = toScreenText(settingsIcon, frame(2));

    // A normalized fraction lands at the same fraction of the window's points,
    // because the capture is exactly `scale` times the window size.
    assert.equal(text.bounds.x, window.x + 0.1 * 400);
    assert.equal(text.bounds.y, window.y + 0.1 * 800);
    assert.equal(text.bounds.width, 0.2 * 400);
    assert.equal(text.bounds.height, 0.04 * 800);
    assert.deepEqual(text.center, { x: 280, y: 196 });
  });

  it('finds the same text regardless of backing scale', () => {
    const at2x = toScreenText(settingsIcon, frame(2));
    const at1x = toScreenText(settingsIcon, frame(1));

    assert.equal(at2x.center.x, at1x.center.x);
    assert.equal(at2x.center.y, at1x.center.y);
  });

  it('selects the most confident candidate from a noisy screen', () => {
    const noisy = [
      toScreenText({ ...settingsIcon, confidence: 0.4, x: 0.7, y: 0.8 }, frame(2)),
      toScreenText(settingsIcon, frame(2)),
    ];
    const target = findText(noisy, 'settings', { mode: 'contains' });
    assert.equal(target?.confidence, 0.98);
    // x = 200 + 40pt, width 80pt → center at 280.
    assert.equal(target?.center.x, 280);
    assert.equal(target?.bounds.x, 240);
  });
});

describe('config', () => {
  it('defaults to macocr and the accurate recognizer', () => {
    const options = defaultOptions({});
    assert.equal(options.backend, 'macocr');
    // Accurate is the default because `fast` reads one character at a time and
    // silently drops short labels such as "Wi-Fi".
    assert.equal(options.ocr.fast, false);
    assert.equal(options.executor.dryRun, false);
    assert.equal(options.windowOwner, 'iPhone Mirroring');
  });

  it('lets --fast opt back into the fast recognizer', () => {
    assert.equal(parseArgs(['--fast']).harness.ocr.fast, true);
    assert.equal(parseArgs(['--slow']).harness.ocr.fast, false);
  });

  it('rejects the retired --custom-words flag', () => {
    // Vocabulary tuning is no longer the user's job; the harness escalates to
    // the accurate recognizer on its own instead.
    assert.throws(() => parseArgs(['--custom-words', 'Wi-Fi']), /unknown flag/);
  });

  it('reads HARNESS_* environment overrides', () => {
    const options = defaultOptions({
      HARNESS_BACKEND: 'replay',
      HARNESS_WINDOW_OWNER: 'Mirror',
      HARNESS_LANGUAGES: 'en-US, ja-JP',
      HARNESS_DRY_RUN: '1',
      HARNESS_GEOMETRY_TTL_MS: '1500',
    });
    assert.equal(options.backend, 'replay');
    assert.equal(options.windowOwner, 'Mirror');
    assert.deepEqual(options.ocr.languages, ['en-US', 'ja-JP']);
    assert.equal(options.executor.dryRun, true);
    assert.equal(options.geometryTtlMs, 1500);
  });

  it('ignores an unknown backend in the environment', () => {
    assert.equal(defaultOptions({ HARNESS_BACKEND: 'tesseract' }).backend, 'macocr');
  });

  it('parses flags in both --key value and --key=value forms', () => {
    const cli = parseArgs(['--backend=cli', '--dry-run', '--settle-ms', '40', '--languages', 'en-US,fr-FR'], {});
    assert.equal(cli.harness.backend, 'cli');
    assert.equal(cli.harness.executor.dryRun, true);
    assert.equal(cli.harness.executor.settleMs, 40);
    assert.deepEqual(cli.harness.ocr.languages, ['en-US', 'fr-FR']);
  });

  it('parses --scenario and --bench', () => {
    const cli = parseArgs(['--scenario', 'scenarios/demo.json', '--bench', '25'], {});
    assert.equal(cli.scenarioPath, 'scenarios/demo.json');
    assert.equal(cli.bench, 25);
  });

  it('requires a fixture for the replay backend', () => {
    assert.throws(() => parseArgs(['--backend', 'replay'], {}), /requires --fixture/);
    const withFixture = parseArgs(['--backend', 'replay', '--fixture', 'f.json'], {});
    assert.equal(withFixture.harness.ocr.fixturePath, 'f.json');
  });

  const rejected: Array<[string[], RegExp]> = [
    [['--nope'], /unknown flag "--nope"/],
    [['--settle-ms', 'soon'], /expects a number/],
    [['--settle-ms'], /requires a value/],
    [['--backend'], /requires a value/],
    [['--backend', 'vision'], /unknown backend "vision"/],
  ];

  for (const [argv, pattern] of rejected) {
    it(`rejects ${argv.join(' ')}`, () => {
      assert.throws(() => parseArgs(argv, {}), pattern);
    });
  }
});
