/** A point in global screen coordinates (points, top-left origin). */
export interface Point {
  x: number;
  y: number;
}

/** A rectangle in global screen coordinates (points, top-left origin). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The on-screen window we are driving. `id` is the CGWindowID. */
export interface WindowBounds extends Rect {
  id: number;
  owner: string;
  title: string | null;
}

/**
 * A text observation normalized to 0..1 with a **top-left origin**, which is
 * what every OCR backend is adapted to before coordinates are projected.
 */
export interface RawObservation {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An observation projected into absolute screen points, ready to click. */
export interface ScreenText {
  text: string;
  confidence: number;
  /** Bounding box in global screen points. */
  bounds: Rect;
  /** Click target: the center of `bounds`. */
  center: Point;
}

/** A captured frame of the target window. */
export interface Frame {
  /** Encoded PNG bytes as returned by `screencapture`. */
  image: Buffer;
  /** Pixel dimensions of `image`. */
  pixelWidth: number;
  pixelHeight: number;
  /** Window geometry at capture time. */
  window: WindowBounds;
  /** Backing scale: pixels per point (2 on Retina). */
  scale: number;
  /** Monotonic capture counter, used as a cache key. */
  generation: number;
  /** Wall-clock cost of the capture, in milliseconds. */
  durationMs: number;
}

export type OcrBackendKind = 'macocr' | 'napi' | 'cli' | 'replay';

export interface OcrOptions {
  /**
   * Prefer Vision's fast recognizer. Defaults to false.
   *
   * The two levels are different algorithms, not a speed dial: `fast` reads one
   * character at a time and drops short, stylized, or hyphenated strings, while
   * the accurate net reads whole words and interpolates over ambiguity. Apple
   * and the `mac-ocr` docs both recommend accurate for still images.
   */
  fast?: boolean;
  /** BCP-47 language codes, e.g. `['en-US']`. */
  languages?: string[];
  /**
   * Noise floor applied when collecting observations, so speculative boxes are
   * never reported or clicked. Note this is *not* a match filter: a query that
   * matches a collected label always succeeds regardless of its confidence.
   */
  minConfidence?: number;
  /**
   * With `fast` enabled, re-recognize the frame accurately if the fast pass
   * yields fewer than this many observations. Fast suits dense text and struggles
   * with sparse screens, so this keeps its latency win where it is safe without
   * ever settling for a near-empty frame. Defaults to 6.
   */
  autoEscalate?: number;
  /** Path to a fixture file, for the `replay` backend only. */
  fixturePath?: string;
  /** Timeout for a single OCR call. */
  timeoutMs?: number;
}

/** Adapter implemented by every OCR engine. */
export interface OcrBackend {
  readonly kind: OcrBackendKind;
  /** Recognize text, returning observations normalized to 0..1 top-left. */
  recognize(image: Buffer, options: OcrOptions): Promise<RawObservation[]>;
  /** Optional capability probe used by `doctor`. */
  available?(): Promise<{ ok: boolean; detail: string }>;
  /**
   * Optional synthetic frame. When present the harness skips screen capture
   * entirely, which is how `replay` runs without Screen Recording permission.
   */
  syntheticFrame?(window: WindowBounds, generation: number): Promise<Frame>;
}

export type MatchMode = 'exact' | 'contains' | 'normalized' | 'regex';

/** What the click aims at when text is only a label for something else. */
export type ClickTarget = 'text' | 'icon';

export interface MatchOptions {
  mode?: MatchMode;
  /** Case-insensitive comparison. Defaults to true. */
  ignoreCase?: boolean;
  /** Pick the n-th match when several share the query (0-based). Defaults to 0. */
  index?: number;
}

/** How to turn a text observation into a click point. */
export interface CenterOptions {
  /**
   * `text` clicks the recognized text itself; `icon` clicks the control *above*
   * it, for home-screen grids where OCR only sees the label.
   */
  target?: ClickTarget;
  /** Fine-tune the click point, in screen points. */
  offsetX?: number;
  offsetY?: number;
}

export interface ExecutorOptions {
  /** Log commands instead of injecting them. */
  dryRun?: boolean;
  /** Reject clicks outside the target window. Defaults to true. */
  requireWithinWindow?: boolean;
  /** Pause after each click, in ms. */
  settleMs?: number;
  /** Per-command timeout, in ms. */
  timeoutMs?: number;
  /** Move the cursor to the target before clicking (adds latency). */
  moveBeforeClick?: boolean;
  /**
   * Hold each click for this many ms instead of a synthetic instant press.
   * Some apps ignore a zero-duration press; a longer hold is more reliable.
   */
  pressMs?: number;
  /** Ask cliclick to describe each action; makes the click visible in logs. */
  verbose?: boolean;
}

export interface HarnessOptions {
  backend: OcrBackendKind;
  ocr: OcrOptions;
  executor: ExecutorOptions;
  /** How long cached window geometry stays valid, in ms. */
  geometryTtlMs: number;
  /** Timeout for a single screen capture, in ms. */
  captureTimeoutMs: number;
  /** Target window owner name to match. */
  windowOwner: string;
  /** Report per-phase timings. */
  profile: boolean;
  /** Launch iPhone Mirroring if the window is not found. */
  launch: boolean;
  /** Verbose logging: print every recognized string with its click target. */
  verbose: boolean;
  /** Directory to write annotated frame+OCR snapshots into, for diagnosis. */
  snapshotDir?: string;
  /** Save every captured frame, not just failures. */
  snapshotAll?: boolean;
  /** Sink for progress and dry-run lines. Defaults to `console.error`. */
  log?: (message: string) => void;
}

export interface Timing {
  captureMs: number;
  ocrMs: number;
  totalMs: number;
}

export interface Screen {
  frame: Frame;
  texts: ScreenText[];
  /** Raw normalized observations, as returned by the backend. */
  observations: RawObservation[];
  timing: Timing;
}

export type Step =
  | {
      action: 'waitFor';
      text: string;
      timeoutMs?: number;
      mode?: MatchMode;
      index?: number;
      description?: string;
    }
  | {
      action: 'click';
      text: string;
      mode?: MatchMode;
      index?: number;
      timeoutMs?: number;
      target?: ClickTarget;
      offsetX?: number;
      offsetY?: number;
      /** Confirm the screen changed. Defaults to true. */
      verify?: boolean;
      description?: string;
    }
  | {
      action: 'doubleClick';
      text: string;
      mode?: MatchMode;
      index?: number;
      timeoutMs?: number;
      target?: ClickTarget;
      offsetX?: number;
      offsetY?: number;
      description?: string;
    }
  | { action: 'tap'; x: number; y: number; description?: string }
  | { action: 'type'; text: string; description?: string }
  | { action: 'key'; key: string; description?: string }
  /**
   * Go to the Home Screen (Cmd-1), pressing repeatedly until `expect` appears.
   * This does NOT close the app; use `forceQuit` to kill it.
   */
  | { action: 'home'; expect?: string; attempts?: number; description?: string }
  /**
   * Kill the foreground app: Cmd-1 (Home Screen) → Cmd-2 (App Switcher) → flick
   * the centred card up and off → Cmd-1. The centred card is the most recently
   * used app, so this needs no OCR. Ends on the Home Screen.
   */
  | { action: 'forceQuit'; settleMs?: number; x?: number; description?: string }
  | { action: 'sleep'; ms: number; description?: string }
  | { action: 'ocr'; save?: string; description?: string };

/** A parsed step plus the retry/optional policy the runner applies to it. */
export interface PlannedStep {
  step: Step;
  retry: number;
  optional: boolean;
  description: string;
}

export interface Scenario {
  name: string;
  description?: string;
  steps: PlannedStep[];
}

export type ErrorCode =
  | 'WINDOW_NOT_FOUND'
  | 'CAPTURE_FAILED'
  | 'OCR_FAILED'
  | 'TEXT_NOT_FOUND'
  | 'CLICLICK_MISSING'
  | 'CLICLICK_FAILED'
  | 'OUT_OF_BOUNDS'
  | 'SCENARIO_INVALID'
  | 'STEP_FAILED'
  | 'TIMEOUT';

export class HarnessError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HarnessError';
    this.code = code;
  }
}
