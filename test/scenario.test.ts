import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeStep, parseScenario, parseStep } from '../src/scenario.js';
import { HarnessError } from '../src/types.js';

describe('parseStep', () => {
  it('parses a minimal waitFor step', () => {
    const planned = parseStep({ action: 'waitFor', text: 'Settings' }, 0);
    assert.deepEqual(planned.step, { action: 'waitFor', text: 'Settings' });
    assert.equal(planned.retry, 0);
    assert.equal(planned.optional, false);
    assert.equal(planned.description, 'waitFor "Settings"');
  });

  it('carries matching options through', () => {
    const planned = parseStep(
      { action: 'click', text: 'Wi-Fi', mode: 'contains', index: 1, timeoutMs: 2500, description: 'open' },
      2,
    );
    assert.deepEqual(planned.step, {
      action: 'click',
      text: 'Wi-Fi',
      mode: 'contains',
      index: 1,
      timeoutMs: 2500,
      description: 'open',
    });
    assert.equal(planned.description, 'open');
  });

  it('parses tap, type, key, sleep and ocr', () => {
    assert.deepEqual(parseStep({ action: 'tap', x: 10, y: 20 }, 0).step, { action: 'tap', x: 10, y: 20 });
    assert.deepEqual(parseStep({ action: 'type', text: 'hi' }, 0).step, { action: 'type', text: 'hi' });
    assert.deepEqual(parseStep({ action: 'key', key: 'return' }, 0).step, { action: 'key', key: 'return' });
    assert.deepEqual(parseStep({ action: 'sleep', ms: 0 }, 0).step, { action: 'sleep', ms: 0 });
    assert.deepEqual(parseStep({ action: 'ocr' }, 0).step, { action: 'ocr' });
    assert.deepEqual(parseStep({ action: 'ocr', save: 'final' }, 0).step, { action: 'ocr', save: 'final' });
  });

  it('parses icon targeting and offsets', () => {
    const planned = parseStep(
      { action: 'click', text: 'Settings', target: 'icon', offsetY: -4, offsetX: 2 },
      0,
    );
    assert.deepEqual(planned.step, {
      action: 'click',
      text: 'Settings',
      target: 'icon',
      offsetX: 2,
      offsetY: -4,
    });
  });

  it('rejects an invalid click target', () => {
    assert.throws(() => parseStep({ action: 'click', text: 'x', target: 'centre' }, 0), /target must be "text" or "icon"/);
  });

  it('parses a home step with expectations', () => {
    const planned = parseStep({ action: 'home', expect: 'Settings', attempts: 4 }, 0);
    assert.deepEqual(planned.step, { action: 'home', expect: 'Settings', attempts: 4 });
    assert.match(planned.description, /home \(expect "Settings"\)/);
  });

  it('rejects the removed relaunch action', () => {
    assert.throws(() => parseStep({ action: 'relaunch' }, 0), /is not supported/);
  });

  it('parses a forceQuit step', () => {
    const planned = parseStep({ action: 'forceQuit', settleMs: 900 }, 0);
    assert.deepEqual(planned.step, { action: 'forceQuit', settleMs: 900 });
    assert.match(planned.description, /App Switcher/);
    assert.deepEqual(parseStep({ action: 'forceQuit' }, 0).step, { action: 'forceQuit' });
    assert.deepEqual(parseStep({ action: 'forceQuit', x: 300 }, 0).step, { action: 'forceQuit', x: 300 });
  });

  it('ignores the retired forceQuit expect field', () => {
    // The centred card is identified by geometry, so a title match is meaningless.
    assert.deepEqual(parseStep({ action: 'forceQuit', expect: 'General' }, 0).step, { action: 'forceQuit' });
  });

  it('rejects invalid home options', () => {
    assert.throws(() => parseStep({ action: 'home', expect: '' }, 0), /expect must be a non-empty string/);
    assert.throws(() => parseStep({ action: 'home', attempts: 0 }, 0), /attempts must be a positive integer/);
    assert.throws(() => parseStep({ action: 'home', attempts: 1.5 }, 0), /attempts must be a positive integer/);
    assert.throws(() => parseStep({ action: 'forceQuit', settleMs: -1 }, 0), /settleMs must be non-negative/);
  });

  it('keeps retry and optional flags', () => {
    const planned = parseStep({ action: 'click', text: 'General', retry: 2, optional: true }, 0);
    assert.equal(planned.retry, 2);
    assert.equal(planned.optional, true);
  });

  const rejected: Array<[string, unknown, RegExp]> = [
    ['a non-object step', 'nope', /must be an object/],
    ['a missing action', { text: 'x' }, /action must be a non-empty string/],
    ['an unknown action', { action: 'swipe' }, /is not supported/],
    ['a missing text', { action: 'click' }, /text must be a non-empty string/],
    ['an empty text', { action: 'click', text: '' }, /text must be a non-empty string/],
    ['an invalid mode', { action: 'click', text: 'x', mode: 'fuzzy' }, /mode must be one of/],
    ['a non-numeric index', { action: 'click', text: 'x', index: 'first' }, /index must be a number/],
    ['a negative retry', { action: 'click', text: 'x', retry: -1 }, /retry must be a non-negative integer/],
    ['a fractional retry', { action: 'click', text: 'x', retry: 1.5 }, /retry must be a non-negative integer/],
    ['tap without y', { action: 'tap', x: 1 }, /requires numeric x and y/],
    ['sleep without ms', { action: 'sleep' }, /non-negative ms/],
    ['a negative sleep', { action: 'sleep', ms: -5 }, /non-negative ms/],
    ['a non-string save', { action: 'ocr', save: 3 }, /save must be a string/],
    ['a missing key name', { action: 'key' }, /key must be a non-empty string/],
  ];

  for (const [label, input, pattern] of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseStep(input, 0), (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, 'SCENARIO_INVALID');
        assert.match(error.message, pattern);
        return true;
      });
    });
  }

  it('names the offending step index', () => {
    assert.throws(() => parseStep({ action: 'nope' }, 4), /steps\[4\]/);
  });
});

describe('parseScenario', () => {
  it('parses a scenario with multiple steps', () => {
    const scenario = parseScenario({
      name: 'demo',
      description: 'smoke',
      steps: [{ action: 'ocr' }, { action: 'sleep', ms: 5 }],
    });
    assert.equal(scenario.name, 'demo');
    assert.equal(scenario.description, 'smoke');
    assert.equal(scenario.steps.length, 2);
  });

  const rejected: Array<[string, unknown, RegExp]> = [
    ['a non-object scenario', [], /scenario must be an object/],
    ['a missing name', { steps: [{ action: 'ocr' }] }, /name must be a non-empty string/],
    ['a missing steps array', { name: 'x' }, /steps must be a non-empty array/],
    ['an empty steps array', { name: 'x', steps: [] }, /steps must be a non-empty array/],
    ['a non-string description', { name: 'x', description: 1, steps: [{ action: 'ocr' }] }, /description must be a string/],
  ];

  for (const [label, input, pattern] of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseScenario(input), pattern);
    });
  }
});

describe('describeStep', () => {
  it('renders every action readably', () => {
    assert.equal(describeStep({ action: 'click', text: 'OK' }), 'click "OK"');
    assert.equal(describeStep({ action: 'tap', x: 1, y: 2 }), 'tap 1,2');
    assert.equal(describeStep({ action: 'sleep', ms: 250 }), 'sleep 250ms');
    assert.equal(describeStep({ action: 'home' }), 'home');
    assert.equal(describeStep({ action: 'ocr', save: 'x' }), 'ocr → x');
    assert.equal(describeStep({ action: 'ocr' }), 'ocr');
  });
});
