import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HarnessError } from './types.js';
import type { ExecutorOptions, Point, Rect, WindowBounds } from './types.js';

const execFileAsync = promisify(execFile);

/** Where `cliclick` was found; resolved once per process. */
let resolvedBinary: string | null = null;

const MODIFIERS = ['cmd', 'ctrl', 'alt', 'shift', 'fn'] as const;
type Modifier = (typeof MODIFIERS)[number];

const isModifier = (token: string): token is Modifier => (MODIFIERS as readonly string[]).includes(token);

/** Keys cliclick accepts for `kp:`; anything else must be typed with `t:`. */
const NAMED_KEYS = new Set([
  'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up', 'brightness-down', 'brightness-up',
  'delete', 'end', 'enter', 'esc', 'fwd-delete', 'home', 'page-down', 'page-up', 'return',
  'space', 'tab', 'volume-down', 'volume-up',
]);

export interface DragOptions {
  /** Intermediate points; more steps make a slower, more reliable gesture. */
  steps?: number;
  /** Total gesture duration in ms, spread across `steps` waits. */
  durationMs?: number;
}

/**
 * Builds a press-drag-release sequence.
 *
 * `cliclick` interpolates nothing on its own: `dd:` starts the drag, `dm:`
 * continues it, and `du:` releases. Intermediate points plus `w:` waits are what
 * give iOS the velocity it needs to recognise a swipe.
 */
export function buildDragArgs(from: Point, to: Point, options: DragOptions = {}): string[] {
  const steps = Math.max(1, Math.round(options.steps ?? 8));
  const durationMs = Math.max(0, Math.round(options.durationMs ?? 200));
  const waitMs = steps > 0 ? Math.max(1, Math.round(durationMs / (steps + 1))) : 0;

  const args = [`m:${pointArg(from)}`, `dd:${pointArg(from)}`];
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    args.push(`dm:${pointArg({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })}`);
    if (waitMs > 0) args.push(`w:${waitMs}`);
  }
  args.push(`du:${pointArg(to)}`);
  return args;
}

/**
 * Builds the cliclick arguments for `key: "cmd+1"` style combos.
 *
 * cliclick's `kd:`/`ku:` accept modifiers only — a digit there is rejected — so the
 * final key must be sent as `t:<char>` (or `kp:<name>` for special keys) while the
 * modifiers are held. This is the only way to reach app shortcuts like Cmd-1
 * (Home Screen) documented for iPhone Mirroring.
 */
export function buildKeyArgs(spec: string): string[] {
  // A trailing "+" means the user forgot the final key; filtering empty parts
  // would silently type "cmd" as text instead.
  if (/\+\s*$/.test(spec) || /^\s*\+/.test(spec)) {
    throw new HarnessError('STEP_FAILED', `"${spec}" is not a valid key combo; expected e.g. "cmd+1"`);
  }
  const parts = spec.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new HarnessError('STEP_FAILED', 'key requires a key name');

  const last = parts[parts.length - 1];
  if (last === undefined) throw new HarnessError('STEP_FAILED', 'key requires a key name');

  if (parts.length === 1) {
    const name = NAMED_KEYS.has(last) || /^f\d{1,2}$/.test(last) || /^num-/.test(last) ? last : null;
    return name ? [`kp:${name}`] : [`t:${last}`];
  }

  const modifiers = parts.slice(0, -1);
  for (const modifier of modifiers) {
    if (!isModifier(modifier)) {
      throw new HarnessError('STEP_FAILED', `"${modifier}" is not a modifier (${MODIFIERS.join(', ')})`);
    }
  }

  const held = modifiers.join(',');
  const press = NAMED_KEYS.has(last) ? `kp:${last}` : `t:${last}`;
  return [`kd:${held}`, press, `ku:${held}`];
}

export const CLICLICK_CANDIDATES = [
  process.env['CLICLICK_PATH'],
  '/opt/homebrew/bin/cliclick',
  '/usr/local/bin/cliclick',
  '/usr/bin/cliclick',
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

/** Resolves the cliclick binary, preferring `CLICLICK_PATH` then Homebrew locations. */
export async function resolveCliclick(): Promise<string> {
  if (resolvedBinary) return resolvedBinary;
  for (const candidate of CLICLICK_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      resolvedBinary = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new HarnessError(
    'CLICLICK_MISSING',
    'cliclick not found. Install it with `brew install cliclick` or set CLICLICK_PATH.',
  );
}

/**
 * Checks whether macOS has granted Accessibility to the calling terminal.
 *
 * `cliclick` prints a warning to stderr when it lacks the privilege; it still
 * *prints* the cursor position, so stdout alone cannot tell you the difference.
 */
export async function probeAccessibility(): Promise<{ ok: boolean; detail: string }> {
  let binary: string;
  try {
    binary = await resolveCliclick();
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }

  try {
    const result = await execFileAsync(binary, ['p'], { timeout: 5000 });
    if (result.stderr.includes('Accessibility privileges not enabled')) {
      return {
        ok: false,
        detail: `cliclick works but macOS has not granted Accessibility to this terminal (cursor read as ${result.stdout.trim()})`,
      };
    }
    return { ok: true, detail: `cursor at ${result.stdout.trim()}` };
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }
}

/** True when `point` lies inside `rect` (edges inclusive). */
export function isWithin(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

/** Translates a {@link Point} into the `x,y` argument cliclick expects. */
export function pointArg(point: Point): string {
  return `${Math.round(point.x)},${Math.round(point.y)}`;
}

/**
 * Turns a step into the cliclick arguments that perform it. Pure so the command
 * building can be unit-tested without spawning anything.
 */
export function buildArgs(
  action: {
    kind: 'click' | 'doubleClick' | 'move' | 'type' | 'key';
    point?: Point;
    text?: string;
    key?: string;
    pressMs?: number;
  },
  options: { moveBeforeClick?: boolean | undefined } = {},
): string[] {
  switch (action.kind) {
    case 'click': {
      if (!action.point) throw new HarnessError('STEP_FAILED', 'click requires a point');
      const coord = pointArg(action.point);
      // An explicit down/wait/up pair makes the press duration real, which some
      // apps require before they recognise a tap.
      const press =
        action.pressMs && action.pressMs > 0
          ? [`dd:${coord}`, `w:${action.pressMs}`, `du:${coord}`]
          : [`c:${coord}`];
      return options.moveBeforeClick ? [`m:${coord}`, ...press] : press;
    }
    case 'doubleClick':
      if (!action.point) throw new HarnessError('STEP_FAILED', 'doubleClick requires a point');
      return options.moveBeforeClick
        ? [`m:${pointArg(action.point)}`, `dc:${pointArg(action.point)}`]
        : [`dc:${pointArg(action.point)}`];
    case 'move':
      if (!action.point) throw new HarnessError('STEP_FAILED', 'move requires a point');
      return [`m:${pointArg(action.point)}`];
    case 'type':
      // `t:` types literal text; newlines become carriage returns.
      return [`t:${(action.text ?? '').replace(/\n/g, '\r')}`];
    case 'key':
      if (!action.key) throw new HarnessError('STEP_FAILED', 'key requires a key name');
      return buildKeyArgs(action.key);
  }
}

export interface CommandResult {
  args: string[];
  durationMs: number;
  dryRun: boolean;
}

/**
 * Thin `cliclick` wrapper. Commands are serialized through one promise chain so
 * concurrent awaits cannot interleave mouse events, and each click is checked
 * against the target window before injection.
 */
export class Executor {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: Required<Pick<ExecutorOptions, 'dryRun' | 'requireWithinWindow' | 'settleMs' | 'timeoutMs'>> &
    Pick<ExecutorOptions, 'moveBeforeClick' | 'verbose'> & { pressMs?: number | undefined };

  constructor(
    options: ExecutorOptions = {},
    private readonly log: (message: string) => void = () => {},
  ) {
    this.options = {
      dryRun: options.dryRun ?? false,
      requireWithinWindow: options.requireWithinWindow ?? true,
      settleMs: options.settleMs ?? 0,
      timeoutMs: options.timeoutMs ?? 5000,
      moveBeforeClick: options.moveBeforeClick ?? false,
      verbose: options.verbose ?? false,
      pressMs: options.pressMs,
    };
  }

  get dryRun(): boolean {
    return this.options.dryRun;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async run(args: string[]): Promise<CommandResult> {
    const started = performance.now();
    if (this.options.dryRun) {
      this.log(`[dry-run] cliclick ${args.join(' ')}`);
      return { args, durationMs: performance.now() - started, dryRun: true };
    }

    const binary = await resolveCliclick();
    // `-m verbose` makes cliclick describe each action as it runs, so the user
    // can watch the pointer move and confirm the target.
    const argv = this.options.verbose ? ['-m', 'verbose', ...args] : args;
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(binary, argv, { timeout: this.options.timeoutMs });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      throw new HarnessError('CLICLICK_FAILED', `cliclick ${args.join(' ')} failed: ${describe(error)}`, {
        cause: error,
      });
    }

    // cliclick exits 0 even when macOS blocks the event, so a missing
    // Accessibility grant would otherwise look exactly like a successful click.
    if (stderr.includes('Accessibility privileges not enabled')) {
      throw new HarnessError(
        'CLICLICK_FAILED',
        `cliclick ran but macOS blocked the event: Accessibility is not granted to this terminal, ` +
          `so "${args.join(' ')}" did nothing. Grant it in System Settings → Privacy & Security → ` +
          `Accessibility, then restart the terminal.`,
      );
    }
    if (this.options.verbose) {
      for (const line of stdout.split('\n')) {
        if (line.trim()) this.log(`[cliclick] ${line.trim()}`);
      }
    }
    return { args, durationMs: performance.now() - started, dryRun: false };
  }

  private guard(point: Point, window: WindowBounds | undefined): void {
    if (!this.options.requireWithinWindow || !window) return;
    if (!isWithin(point, window)) {
      throw new HarnessError(
        'OUT_OF_BOUNDS',
        `click target ${pointArg(point)} is outside "${window.owner}" at ${Math.round(window.x)},${Math.round(window.y)} ` +
          `${Math.round(window.width)}x${Math.round(window.height)} — the window may have moved`,
      );
    }
  }

  private async settle(): Promise<void> {
    if (this.options.settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.settleMs));
    }
  }

  click(point: Point, window?: WindowBounds): Promise<CommandResult> {
    return this.enqueue(async () => {
      this.guard(point, window);
      const result = await this.run(
        buildArgs(
          { kind: 'click', point, ...(this.options.pressMs === undefined ? {} : { pressMs: this.options.pressMs }) },
          { moveBeforeClick: this.options.moveBeforeClick },
        ),
      );
      await this.settle();
      return result;
    });
  }

  doubleClick(point: Point, window?: WindowBounds): Promise<CommandResult> {
    return this.enqueue(async () => {
      this.guard(point, window);
      const result = await this.run(
        buildArgs({ kind: 'doubleClick', point }, { moveBeforeClick: this.options.moveBeforeClick }),
      );
      await this.settle();
      return result;
    });
  }

  /** Presses, drags through interpolated points, and releases. */
  drag(from: Point, to: Point, options: DragOptions & { window?: WindowBounds } = {}): Promise<CommandResult> {
    return this.enqueue(async () => {
      this.guard(from, options.window);
      this.guard(to, options.window);
      const result = await this.run(buildDragArgs(from, to, options));
      await this.settle();
      return result;
    });
  }

  move(point: Point, window?: WindowBounds): Promise<CommandResult> {
    return this.enqueue(async () => {
      this.guard(point, window);
      return this.run(buildArgs({ kind: 'move', point }));
    });
  }

  type(text: string): Promise<CommandResult> {
    return this.enqueue(() => this.run(buildArgs({ kind: 'type', text })));
  }

  key(key: string): Promise<CommandResult> {
    return this.enqueue(() => this.run(buildArgs({ kind: 'key', key })));
  }

  /** Typing goes to the focused field, so this only checks the binary exists. */
  async available(): Promise<{ ok: boolean; detail: string }> {
    if (this.options.dryRun) return { ok: true, detail: 'dry-run (no clicks injected)' };
    try {
      const binary = await resolveCliclick();
      return { ok: true, detail: binary };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return stderr ? `${error.message}: ${stderr}` : error.message;
  }
  return String(error);
}
