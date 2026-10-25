import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { centredCardSwipe, Harness, runScenario } from '../src/index.js';
import { parseScenario } from '../src/scenario.js';
import { HarnessError } from '../src/types.js';
import type { HarnessOptions } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/settings-screen.json', import.meta.url));

const workDir = await mkdtemp(join(tmpdir(), 'genie-test-'));
after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface TestHarness {
  harness: Harness;
  /** Every cliclick command the executor would have run. */
  commands: string[];
  /** Progress lines, for assertions on retries and optional steps. */
  logs: string[];
}

async function makeHarness(overrides: Partial<HarnessOptions> = {}): Promise<TestHarness> {
  const commands: string[] = [];
  const logs: string[] = [];
  // A real window is required for geometry, so the owner is chosen per test.
  const options: HarnessOptions = {
    backend: 'replay',
    ocr: { fixturePath: fixture, minConfidence: 0, fast: true },
    executor: { dryRun: true, requireWithinWindow: true },
    geometryTtlMs: 0,
    captureTimeoutMs: 2000,
    windowOwner: 'Finder',
    profile: false,
    launch: false,
    verbose: false,
    ...overrides,
    log: (message) => {
      const prefix = '[dry-run] cliclick ';
      if (message.startsWith(prefix)) commands.push(message.slice(prefix.length));
      else logs.push(message);
    },
  };

  return { harness: new Harness(options), commands, logs };
}

const hasWindow = async (owner: string): Promise<boolean> => {
  const { listWindows } = await import('../src/window.js');
  return (await listWindows(owner)).length > 0;
};

describe('Harness end-to-end (replay backend, dry run)', () => {
  it('requires a real window for geometry', async (t) => {
    const owners = ['Finder', 'Xcode', 'System Settings', 'iTerm2', 'Notes'];
    const available: string[] = [];
    for (const owner of owners) {
      if (await hasWindow(owner)) available.push(owner);
    }
    if (available.length === 0) {
      t.skip('no suitable window on screen');
      return;
    }
    assert.ok(available.length > 0);
  });

  it('resolves text and clicks its center inside the window', async (t) => {
    const owner = ['Finder', 'Xcode', 'System Settings'].find(() => true);
    if (!owner || !(await hasWindow(owner))) {
      t.skip('no suitable window on screen');
      return;
    }

    const { harness, commands } = await makeHarness({ windowOwner: owner });
    try {
      const window = await harness.window();
      const target = await harness.clickText('General');

      assert.equal(commands.length, 1);
      assert.equal(commands[0], `c:${target.center.x},${target.center.y}`);

      // The click must land inside the window the guard checked.
      assert.ok(target.center.x >= window.x && target.center.x <= window.x + window.width);
      assert.ok(target.center.y >= window.y && target.center.y <= window.y + window.height);

      // Fixture: General at x 0.08..0.24, y 0.32..0.338 → 16% across, 32.9% down.
      assert.equal(target.center.x, Math.round(window.x + window.width * 0.16));
      assert.equal(target.center.y, Math.round(window.y + window.height * 0.329));
    } finally {
      await harness.dispose();
    }
  });

  it('finds text with regex and contains modes', async (t) => {
    if (!(await hasWindow('Finder'))) {
      t.skip('no Finder window on screen');
      return;
    }
    const { harness } = await makeHarness({ windowOwner: 'Finder' });
    try {
      assert.equal((await harness.findAll('wi-?fi', { mode: 'regex' })).length, 1);
      assert.equal((await harness.findAll('display', { mode: 'contains' })).length, 1);
      assert.equal((await harness.findAll('Display & Brightness')).length, 1);
      assert.equal((await harness.findAll('Nothing here')).length, 0);
    } finally {
      await harness.dispose();
    }
  });

  it('reports missing text with the visible-screen dump', async (t) => {
    if (!(await hasWindow('Finder'))) {
      t.skip('no Finder window on screen');
      return;
    }
    const { harness } = await makeHarness({ windowOwner: 'Finder' });
    try {
      await assert.rejects(
        () => harness.waitFor('Nonexistent Label', { timeoutMs: 150 }),
        (error: unknown) => {
          assert.ok(error instanceof HarnessError);
          assert.equal(error.code, 'TEXT_NOT_FOUND');
          assert.match(error.message, /Visible text: Settings \| Wi-Fi/);
          return true;
        },
      );
    } finally {
      await harness.dispose();
    }
  });

  it('runs a scenario and records one command per click step', async (t) => {
    if (!(await hasWindow('Finder'))) {
      t.skip('no Finder window on screen');
      return;
    }
    const { harness, commands, logs } = await makeHarness({ windowOwner: 'Finder' });
    const scenario = parseScenario({
      name: 'e2e',
      steps: [
        // The replay backend always returns the same frame, so verification
        // (which requires the screen to change) is opted out of here.
        { action: 'click', text: 'General', verify: false },
        { action: 'doubleClick', text: 'Bluetooth' },
        { action: 'sleep', ms: 1 },
        { action: 'type', text: 'hello' },
        { action: 'key', key: 'return' },
        { action: 'ocr' },
      ],
    });

    try {
      const runnerLogs: string[] = [];
      const summary = await runScenario(harness, scenario, (message) => runnerLogs.push(message));
      assert.equal(summary.steps, 6);
      assert.equal(summary.failures, 0);
      assert.equal(runnerLogs.filter((line) => line.includes('✓')).length, 6);
      // The `ocr` step dumps through the harness sink, not the runner's.
      assert.ok(logs.some((line) => line.startsWith('[ocr] frame')), `expected an OCR dump, got ${logs.join(' | ')}`);
      assert.deepEqual(
        commands.map((c) => c.split(':')[0]),
        ['c', 'dc', 't', 'kp'],
      );
    } finally {
      await harness.dispose();
    }
  });

  it('retries a failing step and honors the optional flag', async (t) => {
    if (!(await hasWindow('Finder'))) {
      t.skip('no Finder window on screen');
      return;
    }
    const { harness, logs } = await makeHarness({ windowOwner: 'Finder' });
    const scenario = parseScenario({
      name: 'optional',
      steps: [
        { action: 'waitFor', text: 'Missing', timeoutMs: 100, optional: true },
        { action: 'waitFor', text: 'Missing too', timeoutMs: 100, optional: true },
        { action: 'sleep', ms: 1 },
      ],
    });

    try {
      // Optional steps are retried and recorded, but never abort the run.
      const summary = await runScenario(harness, scenario, (message) => logs.push(message));
      assert.equal(summary.failures, 2, 'both optional steps were counted');
      assert.equal(summary.steps, 3);
      assert.equal(logs.filter((line) => line.includes('⚠ optional')).length, 2);
    } finally {
      await harness.dispose();
    }
  });

  it('aborts on a required failure', async (t) => {
    if (!(await hasWindow('Finder'))) {
      t.skip('no Finder window on screen');
      return;
    }
    const { harness } = await makeHarness({ windowOwner: 'Finder' });
    const scenario = parseScenario({
      name: 'fatal',
      steps: [
        { action: 'waitFor', text: 'Missing', timeoutMs: 100 },
        { action: 'sleep', ms: 1 },
      ],
    });

    try {
      await assert.rejects(
        () => runScenario(harness, scenario, () => undefined),
        (error: unknown) => {
          assert.ok(error instanceof HarnessError);
          assert.equal(error.code, 'STEP_FAILED');
          assert.match(error.message, /step 1/);
          return true;
        },
      );
    } finally {
      await harness.dispose();
    }
  });

  it('writes nothing when a fixture is missing', async () => {
    const { harness } = await makeHarness({ ocr: { fixturePath: join(workDir, 'nope.json') } });
    try {
      await assert.rejects(() => harness.screen(), /cannot read fixture/);
    } finally {
      await harness.dispose();
    }
  });

  it('rejects malformed fixtures', async () => {
    const bad = join(workDir, 'bad.json');
    await writeFile(bad, '{ not json');
    const { harness } = await makeHarness({ ocr: { fixturePath: bad } });
    try {
      await assert.rejects(() => harness.screen(), /not valid JSON/);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps the shipped fixtures parseable', async () => {
    for (const path of [fixture, fileURLToPath(new URL('./fixtures/home-screen.json', import.meta.url))]) {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { observations: unknown[] };
      assert.ok(parsed.observations.length > 0, `${path} should contain observations`);
    }
  });
});

describe('window activation', () => {
  it('reports the activation state of the target app', async () => {
    const { activateApp } = await import('../src/window.js');
    // Activation must never throw; an unknown owner reports 'unknown'.
    assert.equal(await activateApp('Definitely Not An App'), 'unknown');
    const result = await activateApp('iPhone Mirroring');
    assert.ok(
      ['activated', 'already-active', 'not-running', 'failed'].includes(result),
      `unexpected activation result: ${result}`,
    );
  });
});

describe('App Switcher centred-card swipe', () => {
  // Real geometry from .shots/0030-f30.json: window 66,148 354x781.
  const window = { x: 66, y: 148, width: 354, height: 781 };

  it('targets the window centre, where the most recent app is rendered', () => {
    const swipe = centredCardSwipe(window);
    assert.equal(swipe.from.x, 243);
    assert.equal(swipe.to.x, 243);
  });

  it('starts low on the card and flings past the top of the window', () => {
    const swipe = centredCardSwipe(window);
    // The card spans ~18%..83% of the window height; the grab point sits near its
    // lower edge so the flick has the whole card to travel.
    assert.ok(swipe.from.y > window.y + window.height * 0.7, `start too high: ${swipe.from.y}`);
    assert.ok(swipe.from.y < window.y + window.height * 0.85, `start below the card: ${swipe.from.y}`);
    assert.ok(swipe.to.y < window.y + window.height * 0.05, `end not past the top: ${swipe.to.y}`);
    assert.ok(swipe.to.y < swipe.from.y);
  });

  it('keeps the whole gesture inside the window', () => {
    const swipe = centredCardSwipe(window);
    for (const point of [swipe.from, swipe.to]) {
      assert.ok(point.x >= window.x && point.x <= window.x + window.width, `x out of bounds: ${point.x}`);
      assert.ok(point.y >= window.y && point.y <= window.y + window.height, `y out of bounds: ${point.y}`);
    }
  });

  it('honours an explicit x override', () => {
    const swipe = centredCardSwipe(window, 300);
    assert.equal(swipe.from.x, 300);
    assert.equal(swipe.to.x, 300);
  });

  it('scales with the window instead of assuming one size', () => {
    const small = centredCardSwipe({ x: 0, y: 0, width: 200, height: 400 });
    const large = centredCardSwipe({ x: 0, y: 0, width: 400, height: 800 });
    assert.equal(small.from.x, 100);
    assert.equal(large.from.x, 200);
    assert.ok(large.from.y > small.from.y);
  });
});
