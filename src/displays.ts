/**
 * Display geometry helpers.
 *
 * Two coordinate spaces matter and they are easy to confuse:
 *
 * - **AppKit / `NSScreen`** uses a bottom-left origin per screen, so a display
 *   arranged *above* the main one has a positive `y`, and the secondary screen's
 *   `y` grows upward from the main screen's top.
 * - **CoreGraphics** (`CGWindowListCopyWindowInfo` bounds, `CGEventPost`,
 *   `screencapture -R`) uses a single top-left origin anchored at the main
 *   display, so a display arranged above the main one has **negative** `y`.
 *
 * The harness only ever uses CoreGraphics space: window bounds come from
 * `CGWindowListCopyWindowInfo` and clicks go through `cliclick` → `CGEventPost`,
 * so no conversion is needed. Mixing in an `NSScreen` rect would silently offset
 * every click on a secondary display, which is why this module converts
 * `NSScreen` values instead of using them directly.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HarnessError } from './types.js';
import type { Rect, WindowBounds } from './types.js';

const execFileAsync = promisify(execFile);

/** A display in CoreGraphics coordinates (top-left origin, main-anchored). */
export interface Display extends Rect {
  id: number;
  /** Backing scale of the display (2 on Retina). */
  scale: number;
  /** True for the display holding the menu bar. */
  main: boolean;
}

const DISPLAY_QUERY = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run() {
  const screens = $.NSScreen.screens;
  const mainFrame = screens.count > 0 ? screens.objectAtIndex(0).frame : null;
  const mainHeight = mainFrame ? mainFrame.size.height : 0;
  const out = [];
  for (let i = 0; i < screens.count; i++) {
    const f = screens.objectAtIndex(i).frame;
    out.push({
      index: i,
      // AppKit is bottom-left per screen; CoreGraphics is top-left from main.
      cgX: f.origin.x,
      cgY: mainHeight - f.origin.y - f.size.height,
      width: f.size.width,
      height: f.size.height,
      scale: screens.objectAtIndex(i).backingScaleFactor,
    });
  }
  return JSON.stringify({ screens: out, mainHeight: mainHeight });
}
`;

interface RawScreen {
  index: number;
  cgX: number;
  cgY: number;
  width: number;
  height: number;
  scale: number;
}

/** Enumerates displays, converted into CoreGraphics coordinates. */
export async function listDisplays(timeoutMs = 5000): Promise<Display[]> {
  let stdout: string;
  try {
    const result = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DISPLAY_QUERY], {
      timeout: timeoutMs,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new HarnessError('CAPTURE_FAILED', `failed to enumerate displays: ${String(error)}`, { cause: error });
  }

  let parsed: { screens?: RawScreen[] };
  try {
    parsed = JSON.parse(stdout.trim() || '{}') as { screens?: RawScreen[] };
  } catch (error) {
    throw new HarnessError('CAPTURE_FAILED', `display enumeration returned invalid JSON: ${stdout.slice(0, 200)}`, {
      cause: error,
    });
  }

  return (parsed.screens ?? []).map((screen, index) => ({
    id: index,
    x: screen.cgX,
    y: screen.cgY,
    width: screen.width,
    height: screen.height,
    scale: screen.scale,
    main: index === 0,
  }));
}

/** The display containing the largest share of `rect`, or `undefined` if none. */
export function displayFor(rect: Rect, displays: readonly Display[]): Display | undefined {
  let best: Display | undefined;
  let bestArea = 0;

  for (const display of displays) {
    const left = Math.max(rect.x, display.x);
    const top = Math.max(rect.y, display.y);
    const right = Math.min(rect.x + rect.width, display.x + display.width);
    const bottom = Math.min(rect.y + rect.height, display.y + display.height);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  return best;
}

/** True when `rect` lies entirely inside `display`. */
export function isOnDisplay(rect: Rect, display: Display): boolean {
  return (
    rect.x >= display.x &&
    rect.y >= display.y &&
    rect.x + rect.width <= display.x + display.width &&
    rect.y + rect.height <= display.y + display.height
  );
}

/**
 * Fingerprints the display arrangement so a monitor being plugged in, removed, or
 * rearranged invalidates cached window geometry.
 */
export function displaySignature(displays: readonly Display[]): string {
  return displays
    .map((d) => `${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.width)}x${Math.round(d.height)}`)
    .join('|');
}

export interface PlacementReport {
  window: WindowBounds;
  display: Display | undefined;
  contained: boolean;
  /** True when the window is on a display other than the main one. */
  onSecondary: boolean;
  displays: Display[];
}

/** Describes where a window sits relative to the displays. */
export async function inspectPlacement(window: WindowBounds): Promise<PlacementReport> {
  const displays = await listDisplays();
  const display = displayFor(window, displays);
  return {
    window,
    display,
    contained: display ? isOnDisplay(window, display) : false,
    onSecondary: display !== undefined && !display.main,
    displays,
  };
}
