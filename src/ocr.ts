import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { HarnessError } from './types.js';
import type {
  CenterOptions,
  Frame,
  Point,
  MatchMode,
  MatchOptions,
  OcrBackend,
  OcrBackendKind,
  OcrOptions,
  RawObservation,
  ScreenText,
  WindowBounds,
} from './types.js';

const execFileAsync = promisify(execFile);

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** Rejects boxes with a non-positive extent so projection never divides badly. */
const usable = (obs: RawObservation): boolean => obs.text.trim().length > 0 && obs.width > 0 && obs.height > 0;

const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

const applyMinConfidence = (observations: RawObservation[], minConfidence: number | undefined): RawObservation[] =>
  observations
    .filter(usable)
    .filter((o) => minConfidence === undefined || o.confidence >= minConfidence)
    .map((o) => ({ ...o, text: normalizeText(o.text) }));

/* -------------------------------------------------------------------------- */
/* Backends                                                                    */
/* -------------------------------------------------------------------------- */

interface MacOcrObservation {
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

interface MacOcrResult {
  observations: MacOcrObservation[];
}

/**
 * Primary backend: `mac-ocr` is a thin wrapper over Apple's Vision framework
 * that ships a prebuilt universal binary, so it needs no compiler and no network
 * access. It already reports normalized, top-left-origin boxes.
 */
class MacOcrBackend implements OcrBackend {
  readonly kind = 'macocr' as const;
  private module: { ocr: (input: Buffer, options?: Record<string, unknown>) => Promise<MacOcrResult> } | null = null;

  private async load(): Promise<{ ocr: (input: Buffer, options?: Record<string, unknown>) => Promise<MacOcrResult> }> {
    if (this.module) return this.module;
    try {
      const imported: unknown = await import('mac-ocr');
      const candidate = imported as { ocr?: unknown };
      if (typeof candidate.ocr !== 'function') throw new Error('module has no `ocr` export');
      this.module = imported as { ocr: (input: Buffer, options?: Record<string, unknown>) => Promise<MacOcrResult> };
      return this.module;
    } catch (error) {
      throw new HarnessError('OCR_FAILED', `mac-ocr could not be loaded: ${describe(error)}`, { cause: error });
    }
  }

  async recognize(image: Buffer, options: OcrOptions): Promise<RawObservation[]> {
    const { ocr } = await this.load();
    const config: Record<string, unknown> = {};
    if (options.fast !== undefined) config['fast'] = options.fast;
    if (options.languages?.length) config['languages'] = options.languages;
    if (options.minConfidence !== undefined) config['confidence'] = options.minConfidence;

    let result: MacOcrResult;
    try {
      result = await withTimeout(ocr(image, config), options.timeoutMs, 'mac-ocr');
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('OCR_FAILED', `mac-ocr failed: ${describe(error)}`, { cause: error });
    }

    const observations = (result.observations ?? []).map((o) => ({
      text: o.text,
      confidence: clamp01(o.confidence),
      x: clamp01(o.boundingBox.x),
      y: clamp01(o.boundingBox.y),
      width: clamp01(o.boundingBox.width),
      height: clamp01(o.boundingBox.height),
    }));
    return applyMinConfidence(observations, options.minConfidence);
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.load();
      return { ok: true, detail: 'mac-ocr (Vision, prebuilt binary)' };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }
}

interface NapiModule {
  RECOGNITION_LEVEL_FAST?: number;
  RECOGNITION_LEVEL_ACCURATE?: number;
  recognizeFromBuffer: (
    buffer: Buffer,
    options?: { languages?: string; recognitionLevel?: number; minConfidence?: number },
  ) => Promise<{
    observations: Array<{ text: string; confidence: number; x: number; y: number; width: number; height: number }>;
  }>;
}

/**
 * Opt-in backend: the N-API module talks to Vision in-process but needs a
 * `node-gyp` build and caps at Node < 24. It reports **bottom-left** origins,
 * which are flipped here so downstream code sees one convention.
 */
class NapiBackend implements OcrBackend {
  readonly kind = 'napi' as const;
  private module: NapiModule | null = null;

  private async load(): Promise<NapiModule> {
    if (this.module) return this.module;
    try {
      const imported: unknown = await import('@cherrystudio/mac-system-ocr');
      const candidate = (imported as { default?: unknown }).default ?? imported;
      const mod = candidate as Partial<NapiModule>;
      if (typeof mod.recognizeFromBuffer !== 'function') throw new Error('module has no `recognizeFromBuffer`');
      this.module = mod as NapiModule;
      return this.module;
    } catch (error) {
      throw new HarnessError(
        'OCR_FAILED',
        `@cherrystudio/mac-system-ocr is not usable (it needs a node-gyp build and Node < 24): ${describe(error)}`,
        { cause: error },
      );
    }
  }

  async recognize(image: Buffer, options: OcrOptions): Promise<RawObservation[]> {
    const mod = await this.load();
    const fast = mod.RECOGNITION_LEVEL_FAST ?? 0;
    const accurate = mod.RECOGNITION_LEVEL_ACCURATE ?? 1;
    const config = {
      languages: (options.languages ?? ['en-US']).join(', '),
      recognitionLevel: options.fast === true ? fast : accurate,
      minConfidence: options.minConfidence ?? 0,
    };

    let result: Awaited<ReturnType<NapiModule['recognizeFromBuffer']>>;
    try {
      result = await withTimeout(mod.recognizeFromBuffer(image, config), options.timeoutMs, 'napi OCR');
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('OCR_FAILED', `napi OCR failed: ${describe(error)}`, { cause: error });
    }

    const observations = (result.observations ?? []).map((o) => ({
      text: o.text,
      confidence: clamp01(o.confidence),
      x: clamp01(o.x),
      // Vision: bottom-left origin → top-left origin.
      y: clamp01(1 - (o.y + o.height)),
      width: clamp01(o.width),
      height: clamp01(o.height),
    }));
    return applyMinConfidence(observations, options.minConfidence);
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 24) return { ok: false, detail: `napi OCR supports Node < 24 (running ${process.versions.node})` };
    try {
      await this.load();
      return { ok: true, detail: 'napi module (Vision, in-process)' };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }
}

/**
 * Debug backend: drives the `mac-ocr` CLI so OCR can be checked independently of
 * the Node integration. Images are passed on stdin (`-`).
 */
class CliOcrBackend implements OcrBackend {
  readonly kind = 'cli' as const;

  async recognize(image: Buffer, options: OcrOptions): Promise<RawObservation[]> {
    const args = ['--format', 'json', '-'];
    if (options.fast === true) args.unshift('--fast');
    for (const language of options.languages ?? []) args.unshift('--language', language);
    if (options.minConfidence !== undefined) args.unshift('--confidence', String(options.minConfidence));

    const stdout = await runWithStdin('npx', ['--no-install', 'mac-ocr', ...args], image, options.timeoutMs ?? 10_000);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout || '[]');
    } catch (error) {
      throw new HarnessError('OCR_FAILED', `mac-ocr CLI returned invalid JSON: ${stdout.slice(0, 200)}`, { cause: error });
    }

    const pages = (Array.isArray(parsed) ? parsed : [parsed]) as MacOcrResult[];
    const observations = pages.flatMap((page) =>
      (page.observations ?? []).map((o) => ({
        text: o.text,
        confidence: clamp01(o.confidence),
        x: clamp01(o.boundingBox.x),
        y: clamp01(o.boundingBox.y),
        width: clamp01(o.boundingBox.width),
        height: clamp01(o.boundingBox.height),
      })),
    );
    return applyMinConfidence(observations, options.minConfidence);
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      await execFileAsync('npx', ['--no-install', 'mac-ocr', '--version'], { timeout: 10_000 });
      return { ok: true, detail: 'mac-ocr CLI' };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }
}

interface FixtureFile {
  width?: number;
  height?: number;
  observations?: RawObservation[];
}

/**
 * Test/demo backend: replays a JSON fixture instead of running Vision, so the
 * pipeline can be exercised where screen capture or Vision is unavailable. It
 * also supplies a synthetic frame, so no capture permission is needed.
 */
class ReplayBackend implements OcrBackend {
  readonly kind = 'replay' as const;

  constructor(private readonly fixturePath: string) {}

  private async read(): Promise<FixtureFile> {
    let raw: string;
    try {
      raw = await readFile(this.fixturePath, 'utf8');
    } catch (error) {
      throw new HarnessError('OCR_FAILED', `cannot read fixture ${this.fixturePath}: ${describe(error)}`, {
        cause: error,
      });
    }
    try {
      return JSON.parse(raw) as FixtureFile;
    } catch (error) {
      throw new HarnessError('OCR_FAILED', `fixture ${this.fixturePath} is not valid JSON`, { cause: error });
    }
  }

  /**
   * A synthetic frame matching the window in points, so fixture coordinates are
   * treated as fractions of the window and clicks land inside it.
   */
  async syntheticFrame(window: WindowBounds, generation: number): Promise<Frame> {
    await this.read();
    return {
      image: Buffer.alloc(0),
      pixelWidth: Math.round(window.width),
      pixelHeight: Math.round(window.height),
      window,
      scale: 1,
      generation,
      durationMs: 0,
    };
  }

  async recognize(_image: Buffer, options: OcrOptions): Promise<RawObservation[]> {
    const fixture = await this.read();
    const observations = (fixture.observations ?? []).map((o) => ({
      text: o.text,
      confidence: clamp01(o.confidence ?? 1),
      x: clamp01(o.x),
      y: clamp01(o.y),
      width: clamp01(o.width),
      height: clamp01(o.height),
    }));
    return applyMinConfidence(observations, options.minConfidence);
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `replay (${this.fixturePath})` };
  }
}

export interface CreateBackendOptions {
  kind: OcrBackendKind;
  fixturePath?: string;
}

export function createBackend(options: CreateBackendOptions): OcrBackend {
  switch (options.kind) {
    case 'macocr':
      return new MacOcrBackend();
    case 'napi':
      return new NapiBackend();
    case 'cli':
      return new CliOcrBackend();
    case 'replay':
      if (!options.fixturePath) {
        throw new HarnessError('SCENARIO_INVALID', 'the replay backend requires a fixture path');
      }
      return new ReplayBackend(options.fixturePath);
  }
}

/* -------------------------------------------------------------------------- */
/* Coordinates                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Projects a normalized top-left-origin observation onto the screen.
 *
 * The capture is in pixels while window geometry is in points, so everything is
 * divided by the backing scale (2 on Retina) before the window offset is added.
 */
export function toScreenText(observation: RawObservation, frame: Frame): ScreenText {
  const { window, pixelWidth, pixelHeight } = frame;
  const scale = frame.scale > 0 ? frame.scale : 1;

  const leftPx = observation.x * pixelWidth;
  const topPx = observation.y * pixelHeight;
  const widthPx = observation.width * pixelWidth;
  const heightPx = observation.height * pixelHeight;

  const x = window.x + leftPx / scale;
  const y = window.y + topPx / scale;
  const width = widthPx / scale;
  const height = heightPx / scale;

  // A box that overhangs the image edge would project its center past the
  // window; clamp so a click can never land outside the target.
  const centerX = Math.min(window.x + window.width, Math.max(window.x, x + width / 2));
  const centerY = Math.min(window.y + window.height, Math.max(window.y, y + height / 2));

  return {
    text: observation.text,
    confidence: observation.confidence,
    bounds: { x, y, width, height },
    center: { x: Math.round(centerX), y: Math.round(centerY) },
  };
}

/**
 * Vertical distance from a label's center to the center of the icon above it, as
 * a multiple of the label's own height.
 *
 * Vision reports text only, so a home-screen app label has no icon box. The value
 * is a *ratio* rather than a pixel offset because both terms scale together:
 * iOS home-screen metrics are fixed in device points (icon 60pt, icon-center to
 * label-center 40pt, label ~9.4pt), and iPhone Mirroring renders the device at
 * `s = windowWidth / deviceWidth`. Both the gap and the label height are
 * multiplied by `s`, so it cancels:
 *
 *   390x844 device, window 354pt wide  -> s = 0.9077
 *   gap 40.00 * 0.9077 = 36.31pt, label 9.36 * 0.9077 = 8.50pt -> 4.274
 *   428x926 device, window 354pt wide  -> s = 0.8271
 *   gap 33.08pt,                  label 7.74pt                 -> 4.274
 *
 * Verified against a real 708x1562 capture: label box 17px (8.5pt), icon box
 * 103px, icon center 73px (36.3pt) above the label center. The projected point
 * matched the measured icon center exactly.
 *
 * This holds for any uniformly scaled device. It will NOT hold if iOS 18+ Home
 * Screen customization changes label/icon metrics, or under display zoom — for
 * those, set an explicit `offsetY` on the step instead of relying on the ratio.
 */
export const ICON_OFFSET_LABEL_HEIGHTS = 4.274;

/**
 * Resolves the click point for an observation.
 *
 * `target: 'icon'` shifts the point up to the control that the text labels —
 * clicking the middle of a home-screen label does nothing, because the tappable
 * element is the icon above it.
 */
export function clickPoint(text: ScreenText, options: CenterOptions = {}): Point {
  const target = options.target ?? 'text';
  const base =
    target === 'icon'
      ? { x: text.center.x, y: text.center.y - ICON_OFFSET_LABEL_HEIGHTS * text.bounds.height }
      : text.center;

  const x = Math.round(base.x + (options.offsetX ?? 0));
  const y = Math.round(base.y + (options.offsetY ?? 0));
  return { x, y };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Folds away differences OCR may introduce without changing what a label means:
 * dash variants, curly quotes, and repeated whitespace.
 *
 * Apple's recognizers do not agree on dashes — a hyphen can come back as `-`,
 * `‐`, `‑`, `–` or `—` — and the accurate net often inserts a space after a
 * separator (`10- 25MIN`). Comparing on the folded form makes a query match
 * regardless of which variant Vision chose.
 */
const foldForMatch = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Folded comparison that also ignores whitespace adjacent to a separator. */
const foldLoose = (value: string, ignoreCase: boolean): string =>
  foldForMatch(ignoreCase ? value.toLowerCase() : value).replace(/\s*-\s*/g, '-');

const matches = (text: string, query: string, mode: MatchMode, ignoreCase: boolean): boolean => {
  switch (mode) {
    case 'exact':
      return ignoreCase ? text.toLowerCase() === query.toLowerCase() : text === query;
    case 'contains':
      return ignoreCase ? text.toLowerCase().includes(query.toLowerCase()) : text.includes(query);
    case 'normalized':
      return foldLoose(text, ignoreCase).includes(foldLoose(query, ignoreCase));
    case 'regex':
      try {
        return new RegExp(query, ignoreCase ? 'i' : '').test(text);
      } catch {
        return false;
      }
  }
};

/**
 * Finds observations matching `query`, ordered by confidence (desc) and then by
 * area (desc) so the most prominent candidate wins; `index` disambiguates.
 *
 * `minConfidence` is deliberately *not* applied here. It exists to discard
 * speculative noise, but a query is a statement of intent: if the caller asks for
 * `"Wi-Fi"` and OCR read `"Wi-Fi"`, a low confidence means the recognizer was
 * unsure of the glyphs, not that the label is absent. Filtering by confidence at
 * match time silently converts "found, low confidence" into "not on screen",
 * which then reports a misleading `TEXT_NOT_FOUND`. Noise is already suppressed
 * upstream when the observations are collected.
 */
export function matchText(elements: readonly ScreenText[], query: string, options: MatchOptions = {}): ScreenText[] {
  const mode = options.mode ?? 'exact';
  const ignoreCase = options.ignoreCase ?? true;

  return elements
    .filter((element) => matches(element.text, query, mode, ignoreCase))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height;
    });
}

/** Like {@link matchText} but returns a single element (honoring `options.index`). */
export function findText(
  elements: readonly ScreenText[],
  query: string,
  options: MatchOptions = {},
): ScreenText | undefined {
  const index = options.index ?? 0;
  return matchText(elements, query, options)[index];
}

/** Runs OCR for a frame and projects every observation onto the screen. */
export async function recognizeFrame(
  backend: OcrBackend,
  frame: Frame,
  options: OcrOptions,
): Promise<{ texts: ScreenText[]; observations: RawObservation[]; ocrMs: number }> {
  const started = performance.now();
  const observations = await backend.recognize(frame.image, options);
  const ocrMs = performance.now() - started;
  return { texts: observations.map((o) => toScreenText(o, frame)), observations, ocrMs };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new HarnessError('TIMEOUT', `${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs a command with `input` piped to its stdin and resolves with stdout.
 * `execFile` has no `input` option, so the child is spawned directly.
 */
function runWithStdin(command: string, args: string[], input: Buffer, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (error: HarnessError | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? '');
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new HarnessError('TIMEOUT', `${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      finish(new HarnessError('OCR_FAILED', `${command} could not start: ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (code === 0) {
        finish(null, out);
        return;
      }
      const err = Buffer.concat(stderr).toString('utf8').trim();
      finish(
        new HarnessError(
          'OCR_FAILED',
          `${command} exited with code ${code ?? 'null'}${err ? `: ${err}` : ''}`,
        ),
      );
    });

    // EPIPE if the child exits early; the close handler reports the real error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return stderr ? `${error.message}: ${stderr}` : error.message;
  }
  return String(error);
}
