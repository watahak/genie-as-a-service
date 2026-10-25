import { pathToFileURL } from 'node:url';
import { HELP, parseArgs } from './config.js';
import { Executor } from './executor.js';
import { clickPoint, createBackend, findText, matchText, recognizeFrame } from './ocr.js';
import { loadScenario } from './scenario.js';
import { writeSnapshot } from './snapshot.js';
import { HarnessError } from './types.js';
import type {
  ExecutorOptions,
  Frame,
  HarnessOptions,
  MatchOptions,
  OcrBackend,
  OcrOptions,
  CenterOptions,
  PlannedStep,
  Point,
  Rect,
  Screen,
  ScreenText,
  Step,
  WindowBounds,
} from './types.js';
import { activateApp, Capturer, WindowLocator } from './window.js';

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 120;

/** Sparse-frame threshold below which a fast OCR pass is re-run accurately. */
const DEFAULT_AUTO_ESCALATE = 6;

export interface WaitOptions extends MatchOptions, CenterOptions {
  timeoutMs?: number;
  pollMs?: number;
  description?: string;
}

/**
 * Perceive → act orchestrator. Each mutation re-captures so a click always
 * lands on what the last frame showed.
 */
export class Harness {
  private readonly backend: OcrBackend;
  private readonly locator: WindowLocator;
  private readonly capturer: Capturer;
  private readonly executor: Executor;
  private readonly options: HarnessOptions;
  /** Sink for progress, dry-run and OCR-dump lines. */
  readonly log: (message: string) => void;

  constructor(options: HarnessOptions) {
    this.options = options;
    this.log = options.log ?? ((message) => console.error(message));
    this.backend = createBackend({ kind: options.backend, ...(options.ocr.fixturePath === undefined ? {} : { fixturePath: options.ocr.fixturePath }) });
    this.locator = new WindowLocator({
      owner: options.windowOwner,
      geometryTtlMs: options.geometryTtlMs,
      launch: options.launch,
      verbose: options.verbose,
    });
    this.capturer = new Capturer({ timeoutMs: options.captureTimeoutMs, verbose: options.verbose });
    this.executor = new Executor({ ...options.executor, verbose: options.executor.verbose ?? options.verbose }, this.log);
  }

  /** Resolves the target window, launching the app once if configured to. */
  async window(force = false): Promise<WindowBounds> {
    return this.locator.locate(force);
  }

  /** Captures the window and OCRs it. Returns projected screen text. */
  async screen(): Promise<Screen> {
    const started = performance.now();
    const window = await this.locator.locate();
    const frame = await this.capture(window);

    const { texts, observations, ocrMs } = await this.recognize(frame);
    const screen: Screen = {
      frame,
      texts,
      observations,
      timing: { captureMs: frame.durationMs, ocrMs, totalMs: performance.now() - started },
    };
    this.lastScreen = screen;

    if (this.options.profile) {
      this.log(
        `[profile] capture ${frame.durationMs.toFixed(1)}ms · ocr ${ocrMs.toFixed(1)}ms · ` +
          `total ${screen.timing.totalMs.toFixed(1)}ms · ${texts.length} boxes`,
      );
    }
    if (this.options.verbose) {
      for (const text of texts) {
        this.log(
          `[ocr] "${text.text}" @ ${text.center.x},${text.center.y} (${text.confidence.toFixed(2)})`,
        );
      }
    }

    if (this.options.snapshotDir && (this.options.snapshotAll || this.options.verbose)) {
      await this.saveSnapshot(screen);
    }
    return screen;
  }

  /** Polls until `query` appears, returning the match. */
  async waitFor(query: string, options: WaitOptions = {}): Promise<ScreenText> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const deadline = performance.now() + timeoutMs;
    let last: Screen | null = null;

    for (;;) {
      last = await this.screen();
      const match = findText(last.texts, query, options);
      if (match) return match;

      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const mode = options.mode ?? 'exact';
        const why =
          last.texts.length === 0
            ? 'OCR recognized no text at all — the window may be blank, off screen, or Vision is unavailable'
            : mode === 'exact'
              ? 'no text matched exactly; retry with mode "contains" or "regex" to match partial strings'
              : `no text matched with mode "${mode}"`;
        throw new HarnessError(
          'TEXT_NOT_FOUND',
          `"${query}" not found after ${timeoutMs}ms${options.description ? ` (${options.description})` : ''}. ` +
            `${why}. Visible text: ${summarize(last.texts)}` +
            (last.texts.length > 0 ? `. Closest: ${nearest(last.texts, query)}` : ''),
        );
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }

  /** Waits for `query`, then clicks its center. */
  /**
   * Activates the target app so it is frontmost before a click.
   *
   * Without this macOS delivers the first click to the window server as an
   * activation click: the app comes forward, the control is never pressed, and
   * the screen does not change — indistinguishable from a broken click.
   */
  async focus(): Promise<void> {
    const result = await activateApp(this.options.windowOwner);
    if (result === 'activated') this.log(`[focus] activated "${this.options.windowOwner}"`);
    if (result === 'failed') {
      this.log(
        `[focus] could not activate "${this.options.windowOwner}" — the first click may be swallowed`,
      );
    }
    // Give the window server a moment to make the window key.
    if (result === 'activated') await sleep(150);
  }

  async clickText(query: string, options: WaitOptions = {}): Promise<ScreenText> {
    const target = await this.waitFor(query, options);
    await this.focus();
    const window = await this.window(true);
    await this.executor.click(clickPoint(target, options), window);
    return target;
  }

  async doubleClickText(query: string, options: WaitOptions = {}): Promise<ScreenText> {
    const target = await this.waitFor(query, options);
    await this.focus();
    const window = await this.window(true);
    await this.executor.doubleClick(clickPoint(target, options), window);
    return target;
  }

  /** Clicks an absolute screen point, guarded against the window rect. */
  async tap(x: number, y: number): Promise<void> {
    await this.focus();
    const window = await this.window(true);
    await this.executor.click({ x, y }, window);
  }

  /**
   * Clicks and confirms the screen reacted. UI navigation should always change
   * something; if nothing changes the click was swallowed (wrong window, blocked
   * event, or the app ignored it), which is otherwise invisible.
   */
  async clickAndVerify(query: string, options: WaitOptions = {}): Promise<boolean> {
    const before = await this.screen();
    const target = findText(before.texts, query, options);
    if (!target) {
      throw new HarnessError('TEXT_NOT_FOUND', `"${query}" is not visible, so nothing was clicked`);
    }

    await this.focus();
    const window = await this.window(true);
    const point = clickPoint(target, options);
    await this.executor.click(point, window);

    const deadline = performance.now() + (options.timeoutMs ?? 2000);
    for (;;) {
      const after = await this.screen();
      if (screenSignature(after) !== screenSignature(before)) return true;
      if (performance.now() >= deadline) {
        this.log(
          `[verify] clicked "${query}" at ${point.x},${point.y} but the screen did not change — ` +
            `the click was likely swallowed`,
        );
        return false;
      }
      await sleep(120);
    }
  }

  /**
   * Force-quits the foreground app via the App Switcher, so the next launch starts
   * at its root page instead of wherever it was left.
   *
   * Sequence: Cmd-1 (Home Screen) → Cmd-2 (App Switcher) → flick the CENTRE card
   * up and off → Cmd-1.
   *
   * Going Home first is what makes the rest deterministic: the switcher then opens
   * on the most recently used app, which is always the centred card. That card is
   * targeted by geometry alone — no OCR. Reading the card's title was the previous
   * approach and it failed in practice: the centred card is often still blurred or
   * blank, so the only readable text belonged to a *background* card, and swiping
   * that one dismissed nothing while still changing the frame.
   */
  async forceQuit(options: { settleMs?: number; holdMs?: number; x?: number } = {}): Promise<void> {
    await this.focus();

    // 1. Home Screen, so the switcher opens at the most recent app.
    await this.executor.key('cmd+1');
    await sleep(600);

    // 2. App Switcher: the most recent app is the centred card.
    await this.executor.key('cmd+2');
    await sleep(options.settleMs ?? 1400);

    const switcher = await this.screen();
    const window = await this.window(true);
    const swipe = centredCardSwipe(window, options.x);

    this.log(
      `[forceQuit] flicking the centred card at x=${swipe.from.x} ` +
        `${swipe.from.y} -> ${swipe.to.y} (window centre ${Math.round(window.x + window.width / 2)})`,
    );

    const before = screenSignature(switcher);

    // Attempts get faster and start a little higher: a slow drag is read as a
    // nudge and iOS snaps the card back.
    const attempts = [
      { from: swipe.from, steps: 6, durationMs: 90 },
      { from: { x: swipe.from.x, y: Math.round(swipe.from.y - (swipe.from.y - swipe.to.y) * 0.1) }, steps: 4, durationMs: 50 },
      { from: { x: swipe.from.x, y: Math.round((swipe.from.y + swipe.to.y) / 2) }, steps: 4, durationMs: 40 },
    ];

    for (const [index, attempt] of attempts.entries()) {
      this.log(
        `[forceQuit] flick ${index + 1}/${attempts.length} ` +
          `${attempt.from.x},${attempt.from.y} -> ${swipe.to.x},${swipe.to.y}`,
      );
      await this.executor.drag(attempt.from, swipe.to, {
        window,
        steps: attempt.steps,
        durationMs: attempt.durationMs,
      });
      await sleep(options.holdMs ?? 600);

      // The card leaving changes what is on screen; if the frame is identical the
      // flick was ignored, so try again rather than pretending it worked.
      const after = await this.screen();
      if (screenSignature(after) !== before) {
        await this.executor.key('cmd+1');
        await sleep(600);
        return;
      }
      this.log('[forceQuit] screen unchanged after the flick — retrying');
    }

    throw new HarnessError(
      'STEP_FAILED',
      'forceQuit: the swipe did not dismiss the centred card after 3 attempts. ' +
        'The App Switcher gesture is unreliable; retry with an explicit `x`, ' +
        'or swipe the card away by hand.',
    );
  }

  /**
   * Returns the mirrored iPhone to its Home Screen.
   *
   * iPhone Mirroring maps Cmd-1 to the Home Screen button, so this uses the
   * documented shortcut rather than hunting for UI. Home does not close a modal
   * sheet or a full-screen app in every case, so it presses once and then
   * verifies with `expect`, retrying up to `attempts` times.
   */
  async resetToHome(options: { expect?: string; attempts?: number; timeoutMs?: number } = {}): Promise<void> {
    const attempts = options.attempts ?? 3;
    const timeoutMs = options.timeoutMs ?? 2500;

    await this.focus();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.executor.key('cmd+1');
      // Let the transition settle before judging the result.
      await sleep(400);

      if (options.expect === undefined) return;

      try {
        await this.waitFor(options.expect, { mode: 'contains', timeoutMs });
        return;
      } catch (error) {
        if (attempt === attempts) {
          throw new HarnessError(
            'STEP_FAILED',
            `reset: Home Screen was requested ${attempts} time(s) but "${options.expect}" never appeared. ` +
              `A modal sheet or full-screen app may be blocking it; dismiss it first.`,
            { cause: error },
          );
        }
        this.log(`[reset] "${options.expect}" not visible after Home (attempt ${attempt}/${attempts}), retrying`);
      }
    }
  }

  /** Types into the focused window, activating the target app first. */
  async typeText(text: string): Promise<void> {
    await this.focus();
    await this.executor.type(text);
  }

  /** Sends a key or combo (e.g. `cmd+1`), activating the target app first. */
  async pressKey(key: string): Promise<void> {
    await this.focus();
    await this.executor.key(key);
  }

  /** All matches for a query in the current frame, best first. */
  async findAll(query: string, options: MatchOptions = {}): Promise<ScreenText[]> {
    const screen = await this.screen();
    return matchText(screen.texts, query, options);
  }

  async dispose(): Promise<void> {
    await this.capturer.dispose();
  }

  /** Most recent frame, kept so a failing step can be diagnosed after the fact. */
  private lastScreen: Screen | null = null;

  /** Writes the frame PNG and its OCR+click targets to `snapshotDir`. */
  async saveSnapshot(screen: Screen): Promise<void> {
    const dir = this.options.snapshotDir;
    if (!dir) return;
    const paths = await writeSnapshot(dir, screen.frame, screen.texts, screen.observations, screen.timing);
    this.log(`[snapshot] ${paths.image} (+ .json)`);
  }

  /** Saves the last successfully captured frame, e.g. when a step fails. */
  async saveLastSnapshot(): Promise<void> {
    if (this.lastScreen) await this.saveSnapshot(this.lastScreen);
  }

  private captureGeneration = 0;

  /**
   * Obtains a frame. Backends that supply a synthetic frame (replay) bypass
   * `screencapture` entirely, so the loop runs without Screen Recording.
   */
  private async capture(window: WindowBounds): Promise<Frame> {
    if (this.backend.syntheticFrame) {
      this.captureGeneration += 1;
      return this.backend.syntheticFrame(window, this.captureGeneration);
    }
    await this.capturer.prepare();
    return this.capturer.capture(window);
  }

  private ocrOptions(override: Partial<OcrOptions> = {}): OcrOptions {
    const { fixturePath, ...rest } = this.options.ocr;
    const merged = { ...rest, ...override };
    return fixturePath === undefined ? merged : { ...merged, fixturePath };
  }

  /**
   * Runs OCR, retrying accurately when a fast pass looks too sparse to trust.
   *
   * Fast recognition is worthwhile on dense screens but unreliable on sparse
   * ones, where a handful of short labels are all there is to find. Escalating on
   * a low observation count keeps the cheap path where it is safe and makes the
   * reliable path automatic everywhere else, so no per-label tuning is needed.
   */
  private async recognize(frame: Frame): ReturnType<typeof recognizeFrame> {
    return recognizeWithEscalation({
      backend: this.backend,
      frame,
      options: this.ocrOptions(),
      log: this.log,
    });
  }
}

export interface RecognizeWithEscalationOptions {
  backend: OcrBackend;
  frame: Frame;
  options: OcrOptions;
  log?: (message: string) => void;
}

/**
 * Runs OCR, retrying accurately when a fast pass looks too sparse to trust.
 *
 * Fast recognition is worthwhile on dense screens but unreliable on sparse ones,
 * where a handful of short labels are all there is to find. Escalating on a low
 * observation count keeps the cheap path where it is safe and makes the reliable
 * path automatic everywhere else, so no per-label tuning is needed.
 */
export async function recognizeWithEscalation({
  backend,
  frame,
  options,
  log,
}: RecognizeWithEscalationOptions): ReturnType<typeof recognizeFrame> {
  const result = await recognizeFrame(backend, frame, options);
  if (options.fast !== true) return result;

  const floor = options.autoEscalate ?? DEFAULT_AUTO_ESCALATE;
  if (result.observations.length >= floor) return result;

  const escalated = await recognizeFrame(backend, frame, { ...options, fast: false });
  log?.(
    `[ocr] fast pass found ${result.observations.length} box(es) (< ${floor}); ` +
      `re-ran accurately and found ${escalated.observations.length}`,
  );
  return {
    texts: escalated.texts,
    observations: escalated.observations,
    ocrMs: result.ocrMs + escalated.ocrMs,
  };
}

/**
 * Executes one scenario step. Steps are retried per their `retry` count and may
 * be marked `optional` to downgrade a failure into a warning.
 */
export async function runStep(harness: Harness, step: Step): Promise<void> {
  switch (step.action) {
    case 'waitFor':
      await harness.waitFor(step.text, matchArgs(step));
      return;
    case 'click': {
      if (step.verify === false) {
        await harness.clickText(step.text, matchArgs(step));
        return;
      }
      const changed = await harness.clickAndVerify(step.text, matchArgs(step));
      if (!changed) {
        throw new HarnessError(
          'STEP_FAILED',
          `clicked "${step.text}" but the screen never changed; the click was swallowed`,
        );
      }
      return;
    }
    case 'doubleClick':
      await harness.doubleClickText(step.text, matchArgs(step));
      return;
    case 'tap':
      await harness.tap(step.x, step.y);
      return;
    case 'type':
      await harness.typeText(step.text);
      return;
    case 'key':
      await harness.pressKey(step.key);
      return;
    case 'home':
      await harness.resetToHome({
        ...(step.expect === undefined ? {} : { expect: step.expect }),
        ...(step.attempts === undefined ? {} : { attempts: step.attempts }),
      });
      return;
    case 'forceQuit':
      await harness.forceQuit({
        ...(step.settleMs === undefined ? {} : { settleMs: step.settleMs }),
        ...(step.x === undefined ? {} : { x: step.x }),
      });
      return;
    case 'sleep':
      await sleep(step.ms);
      return;
    case 'ocr': {
      const screen = await harness.screen();
      const label = step.save ? ` → ${step.save}` : '';
      harness.log(`[ocr] frame ${screen.frame.generation}${label}: ${summarize(screen.texts)}`);
      return;
    }
  }
}

function matchArgs(step: {
  text: string;
  mode?: MatchOptions['mode'];
  index?: number;
  timeoutMs?: number;
  description?: string;
  target?: CenterOptions['target'];
  offsetX?: number;
  offsetY?: number;
}): WaitOptions {
  const options: WaitOptions = {};
  if (step.mode !== undefined) options.mode = step.mode;
  if (step.index !== undefined) options.index = step.index;
  if (step.timeoutMs !== undefined) options.timeoutMs = step.timeoutMs;
  if (step.description !== undefined) options.description = step.description;
  if (step.target !== undefined) options.target = step.target;
  if (step.offsetX !== undefined) options.offsetX = step.offsetX;
  if (step.offsetY !== undefined) options.offsetY = step.offsetY;
  return options;
}

export interface RunSummary {
  steps: number;
  failures: number;
  durationMs: number;
}

/** Runs every step in order, honoring per-step retry and optional flags. */
export async function runScenario(
  harness: Harness,
  scenario: { name: string; steps: readonly PlannedStep[] },
  log: (message: string) => void = (message) => console.error(message),
): Promise<RunSummary> {
  const started = performance.now();
  let failures = 0;

  log(`[scenario] ${scenario.name} (${scenario.steps.length} steps)`);
  for (const [index, planned] of scenario.steps.entries()) {
    const prefix = `[${index + 1}/${scenario.steps.length}]`;
    const attempts = planned.retry + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await runStep(harness, planned.step);
        log(`${prefix} ${planned.description} ✓`);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          log(`${prefix} ${planned.description} ↻ retry ${attempt}/${planned.retry}: ${(error as Error).message}`);
          await sleep(DEFAULT_POLL_MS);
        }
      }
    }

    if (lastError === undefined) continue;
    failures += 1;
    await harness.saveLastSnapshot().catch(() => undefined);
    if (planned.optional) {
      log(`${prefix} ${planned.description} ⚠ optional, skipped: ${(lastError as Error).message}`);
      continue;
    }
    throw new HarnessError(
      'STEP_FAILED',
      `step ${index + 1} (${planned.description}) failed: ${(lastError as Error).message}`,
      { cause: lastError },
    );
  }

  return { steps: scenario.steps.length, failures, durationMs: performance.now() - started };
}

function summarize(texts: readonly ScreenText[]): string {
  if (texts.length === 0) return '(no text recognized)';
  return texts
    .slice(0, 12)
    .map((t) => t.text)
    .join(' | ');
}

/** Suggests the visible strings most similar to `query`, for typo diagnosis. */
function nearest(texts: readonly ScreenText[], query: string, limit = 3): string {
  const target = query.toLowerCase();
  const scored = texts
    .map((text) => ({ text: text.text, score: similarity(text.text.toLowerCase(), target) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((entry) => entry.score > 0.3);
  return scored.length === 0 ? '(nothing similar)' : scored.map((e) => `"${e.text}"`).join(', ');
}

/** Fraction of characters shared by the two strings (Sørensen–Dice on bigrams). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (value: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * Where to grab the centred App Switcher card.
 *
 * The switcher is a carousel: the most recently used app is rendered full-size in
 * the CENTRE, with neighbours scaled down and pushed to the sides. After Cmd-1
 * then Cmd-2 that centred card is always the app to quit, so its position is pure
 * geometry — no OCR, and therefore no dependence on a title that is often blurred
 * or missing entirely.
 *
 * Measured from real frames: the card spans ~18%..83% of the window height and is
 * inset horizontally, so the swipe starts low on the card and flings past the top.
 */
export interface CardSwipe {
  from: Point;
  to: Point;
}

export function centredCardSwipe(window: Rect, x?: number): CardSwipe {
  const centreX = Math.round(window.x + window.width / 2);
  const top = window.y + window.height * 0.18;
  const bottom = window.y + window.height * 0.83;

  return {
    from: { x: x === undefined ? centreX : Math.round(x), y: Math.round(bottom - (bottom - top) * 0.15) },
    to: { x: x === undefined ? centreX : Math.round(x), y: Math.round(window.y + window.height * 0.02) },
  };
}

/** Coarse fingerprint of a screen, used to tell whether anything changed. */
function screenSignature(screen: Screen): string {
  return screen.texts
    .map((t) => `${t.text}@${t.center.x},${t.center.y}`)
    .sort()
    .join('|');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `n` capture+OCR cycles and reports p50/p95 latency. */
async function bench(harness: Harness, cycles: number, log: (message: string) => void): Promise<void> {
  const capture: number[] = [];
  const ocr: number[] = [];
  const total: number[] = [];

  for (let i = 0; i < cycles; i += 1) {
    const screen = await harness.screen();
    capture.push(screen.timing.captureMs);
    ocr.push(screen.timing.ocrMs);
    total.push(screen.timing.totalMs);
  }

  const report = (label: string, values: number[]): void => {
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    log(
      `${label.padEnd(8)} p50 ${pick(0.5).toFixed(1)}ms · p95 ${pick(0.95).toFixed(1)}ms · ` +
        `min ${(sorted[0] ?? 0).toFixed(1)}ms`,
    );
  };

  log(`[bench] ${cycles} cycles`);
  report('capture', capture);
  report('ocr', ocr);
  report('total', total);
}

export async function main(argv: readonly string[], log: (message: string) => void = (m) => console.error(m)): Promise<number> {
  let cli;
  try {
    cli = parseArgs(argv);
  } catch (error) {
    log((error as Error).message);
    return 2;
  }

  if (cli.help) {
    log(HELP);
    return 0;
  }
  if (cli.scenarioPath === undefined && cli.bench === 0) {
    log(HELP);
    return 2;
  }

  const scenario = cli.scenarioPath === undefined ? undefined : await loadScenario(cli.scenarioPath);
  const harness = new Harness({ ...cli.harness, log });

  try {
    if (cli.bench > 0) {
      await bench(harness, cli.bench, log);
      return 0;
    }
    if (!scenario) return 2;
    const summary = await runScenario(harness, scenario, log);
    log(`[scenario] done in ${summary.durationMs.toFixed(0)}ms (${summary.failures} optional failures)`);
    return 0;
  } finally {
    await harness.dispose();
  }
}

const entry = process.argv[1];
const isEntryPoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof HarnessError) {
        console.error(`[error] ${error.code}: ${error.message}`);
      } else {
        console.error('[error]', error);
      }
      process.exitCode = 1;
    });
}

export type { ExecutorOptions, HarnessOptions };
