import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildArgs,
  buildDragArgs,
  buildKeyArgs,
  Executor,
  isWithin,
  pointArg,
  probeAccessibility,
  resolveCliclick,
} from '../src/executor.js';
import { HarnessError } from '../src/types.js';
import type { WindowBounds } from '../src/types.js';

const window: WindowBounds = { id: 1, owner: 'iPhone Mirroring', title: null, x: 100, y: 50, width: 400, height: 800 };

describe('pointArg', () => {
  it('renders integer coordinates', () => {
    assert.equal(pointArg({ x: 12, y: 34 }), '12,34');
  });

  it('rounds fractional coordinates', () => {
    assert.equal(pointArg({ x: 12.4, y: 34.6 }), '12,35');
  });
});

describe('isWithin', () => {
  it('accepts interior and edge points', () => {
    assert.ok(isWithin({ x: 200, y: 400 }, window));
    assert.ok(isWithin({ x: 100, y: 50 }, window), 'top-left corner is inside');
    assert.ok(isWithin({ x: 500, y: 850 }, window), 'bottom-right corner is inside');
  });

  it('rejects points outside the window', () => {
    assert.equal(isWithin({ x: 99, y: 400 }, window), false);
    assert.equal(isWithin({ x: 200, y: 49 }, window), false);
    assert.equal(isWithin({ x: 501, y: 400 }, window), false);
    assert.equal(isWithin({ x: 200, y: 851 }, window), false);
  });
});

describe('buildArgs', () => {
  it('builds a click command', () => {
    assert.deepEqual(buildArgs({ kind: 'click', point: { x: 10, y: 20 } }), ['c:10,20']);
  });

  it('builds a double click command', () => {
    assert.deepEqual(buildArgs({ kind: 'doubleClick', point: { x: 10, y: 20 } }), ['dc:10,20']);
  });

  it('holds the press when pressMs is set', () => {
    assert.deepEqual(buildArgs({ kind: 'click', point: { x: 267, y: 427 }, pressMs: 80 }), [
      'dd:267,427',
      'w:80',
      'du:267,427',
    ]);
  });

  it('combines hold with move-before-click', () => {
    assert.deepEqual(
      buildArgs({ kind: 'click', point: { x: 5, y: 6 }, pressMs: 50 }, { moveBeforeClick: true }),
      ['m:5,6', 'dd:5,6', 'w:50', 'du:5,6'],
    );
  });

  it('ignores a zero press duration', () => {
    assert.deepEqual(buildArgs({ kind: 'click', point: { x: 1, y: 2 }, pressMs: 0 }), ['c:1,2']);
  });

  it('optionally moves before clicking', () => {
    assert.deepEqual(buildArgs({ kind: 'click', point: { x: 1, y: 2 } }, { moveBeforeClick: true }), [
      'm:1,2',
      'c:1,2',
    ]);
  });

  it('builds type and key commands', () => {
    assert.deepEqual(buildArgs({ kind: 'type', text: 'hello world' }), ['t:hello world']);
    assert.deepEqual(buildArgs({ kind: 'key', key: 'return' }), ['kp:return']);
  });

  it('converts newlines so cliclick types them as returns', () => {
    assert.deepEqual(buildArgs({ kind: 'type', text: 'a\nb' }), ['t:a\rb']);
  });

  it('rejects commands with missing operands', () => {
    assert.throws(() => buildArgs({ kind: 'click' }), /click requires a point/);
    assert.throws(() => buildArgs({ kind: 'move' }), /move requires a point/);
    assert.throws(() => buildArgs({ kind: 'key' }), /key requires a key name/);
  });
});

describe('Executor (dry run)', () => {
  it('records commands without spawning cliclick', async () => {
    const log: string[] = [];
    const executor = new Executor({ dryRun: true }, (message) => log.push(message));

    const result = await executor.click({ x: 200, y: 400 }, window);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.args, ['c:200,400']);
    assert.match(log[0] ?? '', /^\[dry-run\] cliclick c:200,400$/);
  });

  it('rejects clicks outside the target window', async () => {
    const executor = new Executor({ dryRun: true });
    await assert.rejects(
      () => executor.click({ x: 10, y: 10 }, window),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, 'OUT_OF_BOUNDS');
        return true;
      },
    );
  });

  it('skips the bounds guard when disabled', async () => {
    const executor = new Executor({ dryRun: true, requireWithinWindow: false });
    const result = await executor.click({ x: 10, y: 10 }, window);
    assert.deepEqual(result.args, ['c:10,10']);
  });

  it('serializes concurrent commands in submission order', async () => {
    const log: string[] = [];
    const executor = new Executor({ dryRun: true }, (message) => log.push(message));

    await Promise.all([
      executor.click({ x: 110, y: 60 }, window),
      executor.type('a'),
      executor.key('return'),
      executor.doubleClick({ x: 120, y: 70 }, window),
    ]);

    assert.deepEqual(
      log.map((line) => line.replace('[dry-run] cliclick ', '')),
      ['c:110,60', 't:a', 'kp:return', 'dc:120,70'],
    );
  });

  it('keeps the queue usable after a failure', async () => {
    const executor = new Executor({ dryRun: true });
    await assert.rejects(() => executor.click({ x: 0, y: 0 }, window), /outside/);
    const result = await executor.click({ x: 200, y: 400 }, window);
    assert.deepEqual(result.args, ['c:200,400']);
  });

  it('reports availability without requiring the binary', async () => {
    const executor = new Executor({ dryRun: true });
    assert.deepEqual(await executor.available(), { ok: true, detail: 'dry-run (no clicks injected)' });
  });
});

describe('resolveCliclick', () => {
  it('throws an actionable error when cliclick is not installed', async (t) => {
    // Skip when the developer has cliclick installed, since resolution is cached.
    const found = await resolveCliclick().catch(() => null);
    if (found) {
      t.skip(`cliclick is installed at ${found}`);
      return;
    }
    await assert.rejects(() => resolveCliclick(), /brew install cliclick/);
  });
});

describe('probeAccessibility', () => {
  it('reports a real result without throwing', async () => {
    const result = await probeAccessibility();
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.detail, 'string');
    assert.ok(result.detail.length > 0);

    // Either outcome is valid on a dev machine; the wording must be actionable.
    if (!result.ok) {
      assert.match(result.detail, /Accessibility|cliclick not found/);
    } else {
      assert.match(result.detail, /cursor at -?\d+,-?\d+/);
    }
  });
});

describe('Executor (verbose relay)', () => {
  it('does not print cliclick output in dry-run mode', async () => {
    const logs: string[] = [];
    const executor = new Executor({ dryRun: true, verbose: true }, (m) => logs.push(m));

    const result = await executor.click({ x: 200, y: 400 }, window);
    assert.deepEqual(result.args, ['c:200,400']);
    assert.deepEqual(logs, ['[dry-run] cliclick c:200,400']);
  });

  it('relays cliclick -m verbose output on a real no-op move', async (t) => {
    if (!(await resolveCliclick().catch(() => null))) {
      t.skip('cliclick not installed');
      return;
    }
    const current = await import('node:child_process').then(({ execFile }) =>
      new Promise<string | null>((resolve) => {
        execFile('/opt/homebrew/bin/cliclick', ['p'], { timeout: 5000 }, (error, stdout) =>
          resolve(error ? null : stdout.trim()),
        );
      }),
    );
    if (!current) {
      t.skip('could not read the cursor position');
      return;
    }

    const [x, y] = current.split(',').map(Number);
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `unexpected cursor position ${current}`);

    const logs: string[] = [];
    const executor = new Executor({ verbose: true, requireWithinWindow: false }, (m) => logs.push(m));

    // Moving to the current position is a harmless way to prove the relay works.
    // Without Accessibility the executor (correctly) refuses, so skip instead.
    const result = await executor.move({ x: x as number, y: y as number }).catch((error: unknown) => {
      if (error instanceof HarnessError && /Accessibility is not granted/.test(error.message)) return null;
      throw error;
    });
    if (result === null) {
      t.skip('Accessibility is not granted to this process');
      return;
    }

    assert.equal(result.dryRun, false);
    assert.equal(logs.length, 1, `expected one relayed line, got ${JSON.stringify(logs)}`);
    assert.match(logs[0] ?? '', /^\[cliclick\] Move to -?\d+,-?\d+$/);
  });
});

describe('buildKeyArgs', () => {
  it('maps named keys to kp:', () => {
    for (const key of ['return', 'esc', 'tab', 'space', 'delete', 'f5', 'arrow-up']) {
      assert.deepEqual(buildKeyArgs(key), [`kp:${key}`], key);
    }
  });

  it('types characters that kp does not know', () => {
    assert.deepEqual(buildKeyArgs('a'), ['t:a']);
    assert.deepEqual(buildKeyArgs('1'), ['t:1']);
  });

  it('holds modifiers around a typed character', () => {
    // cliclick rejects kd:cmd,1 — digits must be typed while cmd is held.
    assert.deepEqual(buildKeyArgs('cmd+1'), ['kd:cmd', 't:1', 'ku:cmd']);
    assert.deepEqual(buildKeyArgs('cmd+2'), ['kd:cmd', 't:2', 'ku:cmd']);
  });

  it('holds modifiers around a named key', () => {
    assert.deepEqual(buildKeyArgs('cmd+space'), ['kd:cmd', 'kp:space', 'ku:cmd']);
  });

  it('supports multiple modifiers in a stable order', () => {
    assert.deepEqual(buildKeyArgs('cmd+shift+4'), ['kd:cmd,shift', 't:4', 'ku:cmd,shift']);
  });

  it('normalizes case and whitespace', () => {
    assert.deepEqual(buildKeyArgs(' CMD + 1 '), ['kd:cmd', 't:1', 'ku:cmd']);
  });

  it('rejects an unknown modifier', () => {
    assert.throws(() => buildKeyArgs('hyper+1'), /is not a modifier/);
  });

  it('rejects an empty key', () => {
    assert.throws(() => buildKeyArgs(''), /requires a key name/);
    assert.throws(() => buildKeyArgs('   '), /requires a key name/);
  });

  it('rejects a dangling modifier instead of typing it as text', () => {
    // Without this guard "cmd+" would type the literal characters c,m,d.
    assert.throws(() => buildKeyArgs('cmd+'), /not a valid key combo/);
    assert.throws(() => buildKeyArgs('+1'), /not a valid key combo/);
  });
});

describe('buildDragArgs', () => {
  it('starts with a move then presses down', () => {
    const args = buildDragArgs({ x: 100, y: 500 }, { x: 100, y: 100 }, { steps: 2, durationMs: 100 });
    assert.equal(args[0], 'm:100,500');
    assert.equal(args[1], 'dd:100,500');
    assert.equal(args[args.length - 1], 'du:100,100');
  });

  it('interpolates intermediate points and pauses between them', () => {
    const args = buildDragArgs({ x: 0, y: 0 }, { x: 0, y: 100 }, { steps: 4, durationMs: 400 });
    const moves = args.filter((a) => a.startsWith('dm:'));
    assert.deepEqual(moves, ['dm:0,25', 'dm:0,50', 'dm:0,75']);
    assert.ok(args.some((a) => a.startsWith('w:')), 'gestures need waits for iOS to see velocity');
  });

  it('reaches the exact destination', () => {
    const args = buildDragArgs({ x: 10, y: 20 }, { x: 210, y: 620 }, { steps: 5, durationMs: 150 });
    assert.equal(args.at(-1), 'du:210,620');
  });

  it('handles a single step without intermediates', () => {
    const args = buildDragArgs({ x: 1, y: 2 }, { x: 3, y: 4 }, { steps: 1, durationMs: 0 });
    assert.deepEqual(args, ['m:1,2', 'dd:1,2', 'du:3,4']);
  });

  it('clamps a zero/negative step count', () => {
    const args = buildDragArgs({ x: 0, y: 0 }, { x: 10, y: 10 }, { steps: 0 });
    assert.equal(args.filter((a) => a.startsWith('dm:')).length, 0);
  });
});
