import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { displaySignature, listDisplays } from './displays.js';
import { HarnessError } from './types.js';
import type { Frame, Rect, WindowBounds } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Enumerates on-screen windows through CoreGraphics and returns those owned by
 * `owner`. Runs inside `osascript -l JavaScript` so no extra native binding is
 * needed; `-s o` keeps AppleScript/System Events out of the path, which avoids
 * the Accessibility prompt that a System Events query would trigger.
 */
const WINDOW_QUERY = `
ObjC.import('CoreGraphics');
function run(argv) {
  const owner = argv[0];
  const options = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const ref = $.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID);
  if (!ref) return '[]';
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  const matches = [];
  for (const w of windows) {
    const name = w.kCGWindowOwnerName;
    if (!name || String(name) !== owner) continue;
    if (w.kCGWindowLayer !== 0) continue;
    const b = w.kCGWindowBounds;
    if (!b) continue;
    matches.push({
      id: w.kCGWindowNumber,
      owner: String(name),
      title: w.kCGWindowName ? String(w.kCGWindowName) : null,
      x: b.X, y: b.Y, width: b.Width, height: b.Height,
    });
  }
  return JSON.stringify(matches);
}
`;

/** Returns every on-screen window owned by `owner`, largest first. */
export async function listWindows(owner: string, timeoutMs = 5000): Promise<WindowBounds[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', WINDOW_QUERY, owner],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new HarnessError('WINDOW_NOT_FOUND', `failed to enumerate windows: ${describe(error)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || '[]');
  } catch (error) {
    throw new HarnessError('WINDOW_NOT_FOUND', `window enumeration returned invalid JSON: ${stdout.slice(0, 200)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) return [];

  return (parsed as WindowBounds[])
    .filter((w) => Number.isFinite(w?.width) && Number.isFinite(w?.height) && w.width > 0 && w.height > 0)
    .map((w) => ({
      id: Number(w.id),
      owner: String(w.owner),
      title: w.title ?? null,
      x: Number(w.x),
      y: Number(w.y),
      width: Number(w.width),
      height: Number(w.height),
    }))
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

/** Finds the mirroring window, or throws with an actionable hint. */
export async function findWindow(owner: string, timeoutMs = 5000): Promise<WindowBounds> {
  const [first] = await listWindows(owner, timeoutMs);
  if (first === undefined) {
    throw new HarnessError(
      'WINDOW_NOT_FOUND',
      `no on-screen "${owner}" window. Open the app and connect your iPhone, or pass --launch.`,
    );
  }
  return first;
}

/** Opens the iPhone Mirroring app. Best effort: failures surface on the next lookup. */
export async function launchApp(owner: string): Promise<void> {
  try {
    await execFileAsync('/usr/bin/open', ['-a', owner], { timeout: 10_000 });
  } catch {
    // The subsequent findWindow() reports the real problem.
  }
}

/** Bundle IDs we can activate directly, so the first click is not swallowed. */
const BUNDLE_IDS: Record<string, string> = {
  'iPhone Mirroring': 'com.apple.ScreenContinuity',
};

const ACTIVATE_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  if (!apps || apps.count === 0) return 'not-running';
  const app = apps.objectAtIndex(0);
  if (app.isActive) return 'already-active';
  const ok = app.activateWithOptions(2 | 1); // IgnoringOtherApps | AllWindows
  return ok ? 'activated' : 'failed';
}
`;

/**
 * Brings the target app to the front.
 *
 * An inactive window swallows the first click: macOS uses it to activate the
 * window and never delivers it to the app, so a correctly-positioned click looks
 * like a no-op. Activating first is what makes the following click land.
 */
export async function activateApp(owner: string, timeoutMs = 5000): Promise<'activated' | 'already-active' | 'not-running' | 'failed' | 'unknown'> {
  const bundleId = BUNDLE_IDS[owner];
  if (!bundleId) return 'unknown';
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', ACTIVATE_SCRIPT, bundleId],
      { timeout: timeoutMs },
    );
    const result = stdout.trim();
    if (result === 'activated' || result === 'already-active' || result === 'not-running') return result;
    return 'failed';
  } catch {
    return 'failed';
  }
}

export interface WindowLocatorOptions {
  owner: string;
  geometryTtlMs: number;
  launch: boolean;
  verbose?: boolean;
}

/**
 * Caches window geometry briefly so a perceive→act cycle issues at most one
 * AppleScript round trip, while still tracking a window the user drags.
 */
export class WindowLocator {
  private cached: { bounds: WindowBounds; at: number } | null = null;
  private launched = false;
  /** Display arrangement last seen; a change invalidates cached geometry. */
  private lastDisplays: string | null = null;

  constructor(private readonly options: WindowLocatorOptions) {}

  /** Drops cached geometry; call after a resize or move is detected. */
  invalidate(): void {
    this.cached = null;
  }

  async locate(force = false): Promise<WindowBounds> {
    const now = Date.now();
    if (!force && this.cached && now - this.cached.at < this.options.geometryTtlMs) {
      // Dragging the window to another monitor is a common manual step; if the
      // display arrangement changed, the cached rect may be stale.
      const signature = await this.displaySignature();
      if (signature === this.lastDisplays) return this.cached.bounds;
    }

    let bounds: WindowBounds;
    try {
      bounds = await findWindow(this.options.owner);
    } catch (error) {
      if (this.options.launch && !this.launched && error instanceof HarnessError) {
        this.launched = true;
        this.options.verbose && console.error(`[window] "${this.options.owner}" not found, launching…`);
        await launchApp(this.options.owner);
        bounds = await findWindow(this.options.owner);
      } else {
        throw error;
      }
    }

    this.cached = { bounds, at: Date.now() };
    this.lastDisplays = await this.displaySignature();
    return bounds;
  }

  private async displaySignature(): Promise<string | null> {
    try {
      return displaySignature(await listDisplays());
    } catch {
      return null;
    }
  }
}

export interface CaptureOptions {
  timeoutMs: number;
  /** Directory for the intermediate PNG. Defaults to a private temp dir. */
  workDir?: string;
  /** Reuse a previous work dir to skip mkdtemp on every frame. */
  reuseDir?: string;
  /** Verbose logging. */
  verbose?: boolean;
}

/**
 * Captures the window as PNG bytes.
 *
 * Uses `screencapture -l<id>` (window-ID capture) so the result contains only the
 * mirroring window with no overlays and no shadow. Falls back to a region capture
 * `-R x,y,w,h` if the window-ID form fails.
 */
export async function captureWindow(window: WindowBounds, options: CaptureOptions): Promise<Buffer> {
  const dir = options.reuseDir ?? options.workDir ?? (await mkdtemp(join(tmpdir(), 'genie-')));
  const ownsDir = options.reuseDir === undefined && options.workDir === undefined;
  const file = join(dir, `frame-${window.id}.png`);

  try {
    await runCapture(['-l', String(window.id), '-o', '-x', file], options.timeoutMs);
    const byId = await readPng(file);
    if (byId) return byId;

    options.verbose && console.error('[window] window-ID capture failed, falling back to region capture');
    const region = `${round(window.x)},${round(window.y)},${round(window.width)},${round(window.height)}`;
    await runCapture(['-x', '-R', region, file], options.timeoutMs);
    const byRegion = await readPng(file);
    if (byRegion) return byRegion;

    throw new HarnessError(
      'CAPTURE_FAILED',
      'screencapture produced no image. Grant Screen Recording to your terminal in System Settings → Privacy & Security.',
    );
  } finally {
    if (ownsDir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runCapture(args: string[], timeoutMs: number): Promise<void> {
  try {
    await execFileAsync('/usr/sbin/screencapture', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const killed = (error as { killed?: boolean }).killed === true;
    if (killed) {
      throw new HarnessError('TIMEOUT', `screencapture timed out after ${timeoutMs}ms`, { cause: error });
    }
    // A non-zero exit can still leave a valid file behind (e.g. -l with no window),
    // so the caller verifies the bytes before giving up.
  }
}

async function readPng(file: string): Promise<Buffer | null> {
  try {
    const buffer = await readFile(file);
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

const round = (value: number): number => Math.round(value);

/** Reads PNG pixel dimensions from the IHDR chunk. */
export function pngSize(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new HarnessError('CAPTURE_FAILED', 'captured data is not a PNG');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Backing scale, computed as pixels per point. */
export function backingScale(pxWidth: number, bounds: Rect): number {
  if (!(bounds.width > 0)) return 1;
  const scale = pxWidth / bounds.width;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Shared capture state: a reused work dir plus a monotonic generation counter. */
export class Capturer {
  private generation = 0;
  private workDir: string | null = null;

  constructor(private readonly options: CaptureOptions) {}

  async prepare(): Promise<void> {
    if (this.options.reuseDir) {
      this.workDir = this.options.reuseDir;
      return;
    }
    if (!this.workDir) this.workDir = await mkdtemp(join(tmpdir(), 'genie-'));
  }

  async capture(window: WindowBounds): Promise<Frame> {
    const started = performance.now();
    this.workDir ??= this.options.workDir ?? (await mkdtemp(join(tmpdir(), 'genie-')));

    const image = await captureWindow(window, { ...this.options, workDir: this.workDir });
    const { width, height } = pngSize(image);
    this.generation += 1;

    return {
      image,
      pixelWidth: width,
      pixelHeight: height,
      window,
      scale: backingScale(width, window),
      generation: this.generation,
      durationMs: performance.now() - started,
    };
  }

  async dispose(): Promise<void> {
    if (this.workDir && !this.options.reuseDir) {
      await rm(this.workDir, { recursive: true, force: true }).catch(() => undefined);
      this.workDir = null;
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
