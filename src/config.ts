import { HarnessError } from './types.js';
import type { ExecutorOptions, HarnessOptions, OcrBackendKind, OcrOptions } from './types.js';

export const DEFAULTS = {
  /** Owner name reported by CGWindowListCopyWindowInfo for the mirroring app. */
  windowOwner: 'iPhone Mirroring',
  backend: 'macocr' as OcrBackendKind,
  geometryTtlMs: 500,
  captureTimeoutMs: 5000,
  ocrTimeoutMs: 5000,
  executor: {
    dryRun: false,
    requireWithinWindow: true,
    settleMs: 0,
    timeoutMs: 5000,
    moveBeforeClick: false,
  } satisfies ExecutorOptions,
  ocr: {
    // Accurate is the default: `fast` reads character-by-character and silently
    // drops short hyphenated labels such as "Wi-Fi". See `--fast` to opt in.
    fast: false,
    languages: ['en-US'],
    minConfidence: 0.3,
    autoEscalate: 6,
  } satisfies OcrOptions,
} as const;

export interface CliOptions {
  harness: HarnessOptions;
  scenarioPath?: string;
  fixturePath?: string;
  bench: number;
  help: boolean;
}

const BACKENDS: readonly OcrBackendKind[] = ['macocr', 'napi', 'cli', 'replay'];

const num = (value: string | undefined, fallback: number, flag: string): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HarnessError('SCENARIO_INVALID', `${flag} expects a number, got "${value}"`);
  }
  return parsed;
};

/** Build the default harness options, then layer `HARNESS_*` env overrides on top. */
export function defaultOptions(env: NodeJS.ProcessEnv = process.env): HarnessOptions {
  const envBackend = env['HARNESS_BACKEND'];
  const backend =
    envBackend && BACKENDS.includes(envBackend as OcrBackendKind)
      ? (envBackend as OcrBackendKind)
      : DEFAULTS.backend;

  const envLanguages = env['HARNESS_LANGUAGES'];

  return {
    backend,
    windowOwner: env['HARNESS_WINDOW_OWNER'] ?? DEFAULTS.windowOwner,
    geometryTtlMs: num(env['HARNESS_GEOMETRY_TTL_MS'], DEFAULTS.geometryTtlMs, 'HARNESS_GEOMETRY_TTL_MS'),
    captureTimeoutMs: num(env['HARNESS_CAPTURE_TIMEOUT_MS'], DEFAULTS.captureTimeoutMs, 'HARNESS_CAPTURE_TIMEOUT_MS'),
    profile: env['HARNESS_PROFILE'] === '1',
    snapshotAll: env['HARNESS_SNAPSHOT_ALL'] === '1',
    ...(env['HARNESS_SNAPSHOT_DIR'] ? { snapshotDir: env['HARNESS_SNAPSHOT_DIR'] } : {}),
    launch: env['HARNESS_LAUNCH'] === '1',
    verbose: env['HARNESS_VERBOSE'] === '1',
    executor: {
      ...DEFAULTS.executor,
      dryRun: env['HARNESS_DRY_RUN'] === '1',
    },
    ocr: {
      ...DEFAULTS.ocr,
      timeoutMs: DEFAULTS.ocrTimeoutMs,
      ...(envLanguages ? { languages: envLanguages.split(',').map((l) => l.trim()) } : {}),
    },
  };
}

/** Minimal argv parser: `--flag`, `--key value`, `--key=value`. Throws on unknown flags. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const harness = defaultOptions(env);
  const result: CliOptions = { harness, bench: 0, help: false };

  const next = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new HarnessError('SCENARIO_INVALID', `${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined) continue;

    const [flag, inline] = raw.includes('=') ? (raw.split(/=(.*)/s, 2) as [string, string]) : [raw, undefined];
    const take = (): string => (inline !== undefined ? inline : next(i++, flag));

    switch (flag) {
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--scenario':
        result.scenarioPath = take();
        break;
      case '--fixture':
        result.fixturePath = take();
        break;
      case '--backend': {
        const value = take();
        if (!BACKENDS.includes(value as OcrBackendKind)) {
          throw new HarnessError('SCENARIO_INVALID', `unknown backend "${value}" (${BACKENDS.join(' | ')})`);
        }
        harness.backend = value as OcrBackendKind;
        break;
      }
      case '--dry-run':
        harness.executor.dryRun = true;
        break;
      case '--profile':
        harness.profile = true;
        break;
      case '--verbose':
        harness.verbose = true;
        break;
      case '--snapshot':
        harness.snapshotDir = take();
        break;
      case '--snapshot-all':
        harness.snapshotAll = true;
        break;
      case '--launch':
        harness.launch = true;
        break;
      case '--fast':
        harness.ocr.fast = true;
        break;
      case '--slow':
        harness.ocr.fast = false;
        break;
      case '--languages':
        harness.ocr.languages = take().split(',').map((l) => l.trim());
        break;
      case '--min-confidence':
        harness.ocr.minConfidence = num(take(), harness.ocr.minConfidence ?? 0, '--min-confidence');
        break;
      case '--settle-ms':
        harness.executor.settleMs = num(take(), harness.executor.settleMs ?? 0, '--settle-ms');
        break;
      case '--press-ms':
        harness.executor.pressMs = num(take(), 0, '--press-ms');
        break;
      case '--show-motion':
        // Moving first makes each click visible: you see the pointer travel
        // to the target instead of it clicking invisibly.
        harness.executor.moveBeforeClick = true;
        harness.executor.settleMs = 250;
        break;
      case '--bench':
        result.bench = num(take(), 10, '--bench');
        break;
      default:
        throw new HarnessError('SCENARIO_INVALID', `unknown flag "${flag}" (try --help)`);
    }
  }

  if (result.fixturePath !== undefined) {
    harness.ocr.fixturePath = result.fixturePath;
  }
  if (harness.backend === 'replay' && harness.ocr.fixturePath === undefined) {
    throw new HarnessError('SCENARIO_INVALID', 'the replay backend requires --fixture <file>');
  }

  return result;
}

export const HELP = `genie-as-a-service — drive iOS apps through iPhone Mirroring

Usage:
  tsx src/index.ts [--scenario <file>] [options]

Options:
  --scenario <file>     Run a JSON scenario (see scenarios/demo.json)
  --backend <kind>      macocr (default) | napi | cli | replay
  --fixture <file>      Observation fixture for the replay backend
  --dry-run             Print clicks instead of injecting them
  --slow                Use Vision's accurate recognizer (default, more precise)
  --fast                Use Vision's fast recognizer (lower latency, misses short labels)
  --languages <list>    Comma-separated BCP-47 codes, e.g. en-US,ja-JP
  --min-confidence <n>  Noise floor when collecting observations (default 0.3)
  --settle-ms <n>       Pause after each click
  --press-ms <n>        Hold each click for n ms (helps apps that ignore instant taps)
  --show-motion         Move the cursor to each target before clicking (visible)
  --profile             Print capture / OCR / click timings
  --verbose             Print recognized text for every frame
  --snapshot <dir>      Write each captured frame + OCR/click JSON into <dir>
  --snapshot-all        With --snapshot: save every frame, not just failures
  --launch              Open iPhone Mirroring when its window is missing
  --bench <n>           Time n capture+OCR cycles and report p50/p95
  -h, --help            Show this help

Environment:
  HARNESS_BACKEND, HARNESS_WINDOW_OWNER, HARNESS_GEOMETRY_TTL_MS,
  HARNESS_CAPTURE_TIMEOUT_MS, HARNESS_LANGUAGES, HARNESS_DRY_RUN=1,
  HARNESS_PROFILE=1, HARNESS_VERBOSE=1, HARNESS_LAUNCH=1, HARNESS_SNAPSHOT_DIR,
  HARNESS_SNAPSHOT_ALL=1, CLICLICK_PATH
`;
