import { pathToFileURL } from 'node:url';
import { defaultOptions } from './config.js';
import { Executor, probeAccessibility } from './executor.js';
import { createBackend } from './ocr.js';
import { displayFor, isOnDisplay, listDisplays } from './displays.js';
import { activateApp, captureWindow, listWindows, pngSize } from './window.js';
import type { OcrBackendKind } from './types.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

const ICON: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };

async function checkNode(): Promise<Check> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22 && major < 24) {
    return { name: 'Node.js', status: 'ok', detail: `v${process.versions.node}` };
  }
  return {
    name: 'Node.js',
    status: major >= 24 ? 'fail' : 'warn',
    detail: `v${process.versions.node} is outside the tested range`,
    hint: 'nvm install 22 && nvm use 22 (the napi OCR module caps at Node < 24)',
  };
}

async function checkBackend(kind: OcrBackendKind, fixturePath: string | undefined): Promise<Check> {
  if (kind === 'replay' && fixturePath === undefined) {
    return { name: `OCR backend (${kind})`, status: 'fail', detail: 'no fixture path given', hint: '--fixture <file>' };
  }
  try {
    const backend = createBackend({ kind, ...(fixturePath === undefined ? {} : { fixturePath }) });
    const result = await backend.available?.();
    if (!result) return { name: `OCR backend (${kind})`, status: 'ok', detail: 'no probe available' };
    return {
      name: `OCR backend (${kind})`,
      status: result.ok ? 'ok' : 'fail',
      detail: result.detail,
      ...(result.ok ? {} : { hint: 'try --backend macocr, or install @cherrystudio/mac-system-ocr' }),
    };
  } catch (error) {
    return { name: `OCR backend (${kind})`, status: 'fail', detail: (error as Error).message };
  }
}

async function checkAccessibility(): Promise<Check> {
  const result = await probeAccessibility();
  return {
    name: 'Accessibility',
    status: result.ok ? 'ok' : 'fail',
    detail: result.detail,
    ...(result.ok
      ? {}
      : { hint: `System Settings → Privacy & Security → Accessibility: enable your terminal, then restart it` }),
  };
}

async function checkCliclick(dryRun: boolean): Promise<Check> {
  const executor = new Executor({ dryRun });
  const result = await executor.available();
  return {
    name: 'cliclick',
    status: result.ok ? 'ok' : 'fail',
    detail: result.detail,
    ...(result.ok ? {} : { hint: 'brew install cliclick' }),
  };
}

/**
 * Reports which display holds the mirroring window, in the coordinate space the
 * clicks actually use. Windows on a secondary display have negative y (or x)
 * offsets from the main display's top-left corner.
 */
async function checkDisplays(): Promise<Check> {
  const name = 'Displays';
  try {
    const displays = await listDisplays();
    const [target] = await listWindows(defaultOptions().windowOwner);
    const summary = displays
      .map((d) => `#${d.id}${d.main ? '(main)' : ''} ${Math.round(d.width)}x${Math.round(d.height)} at ${Math.round(d.x)},${Math.round(d.y)}`)
      .join(', ');

    if (!target) {
      return { name, status: 'warn', detail: `${displays.length} display(s): ${summary}` };
    }

    const display = displayFor(target, displays);
    if (!display) {
      return {
        name,
        status: 'fail',
        detail: `window at ${Math.round(target.x)},${Math.round(target.y)} is on no known display`,
        hint: 'drag the window fully onto one screen',
      };
    }
    if (!isOnDisplay(target, display)) {
      return {
        name,
        status: 'warn',
        detail: `window straddles displays (partly off #${display.id})`,
        hint: 'clicks near the edge may land on the other display',
      };
    }
    return {
      name,
      status: 'ok',
      detail: `window on #${display.id}${display.main ? ' (main)' : ' (secondary)'} at ` +
        `${Math.round(target.x)},${Math.round(target.y)}; ${displays.length} display(s)`,
    };
  } catch (error) {
    return { name, status: 'fail', detail: (error as Error).message };
  }
}

/**
 * An unfocused window swallows the first click (macOS uses it to activate the
 * window), so knowing the app can be brought forward is worth checking.
 */
async function checkFocus(owner: string): Promise<Check> {
  const result = await activateApp(owner);
  if (result === 'unknown') {
    return { name: 'Window focus', status: 'warn', detail: `no bundle id known for "${owner}"; skipping activation` };
  }
  if (result === 'not-running') {
    return { name: 'Window focus', status: 'warn', detail: 'app is not running' };
  }
  if (result === 'failed') {
    return { name: 'Window focus', status: 'fail', detail: 'could not activate the app' };
  }
  return { name: 'Window focus', status: 'ok', detail: result === 'activated' ? 'activated' : 'already frontmost' };
}

async function checkWindow(owner: string): Promise<Check> {
  try {
    const windows = await listWindows(owner);
    const [first] = windows;
    if (!first) {
      return {
        name: `Window ("${owner}")`,
        status: 'warn',
        detail: 'not on screen',
        hint: `open -a "${owner}" and connect your iPhone`,
      };
    }
    return {
      name: `Window ("${owner}")`,
      status: 'ok',
      detail: `id ${first.id} at ${Math.round(first.x)},${Math.round(first.y)} ${Math.round(first.width)}x${Math.round(first.height)}pt`,
    };
  } catch (error) {
    return { name: `Window ("${owner}")`, status: 'fail', detail: (error as Error).message };
  }
}

const PERMISSION_HINT =
  'System Settings → Privacy & Security: enable Screen Recording and Accessibility for your terminal, then restart it';

/**
 * Proves Screen Recording works by capturing the window for real. A permission
 * grant that looks fine in System Settings can still fail here (wrong terminal
 * app, stale grant after an update), so this is the only reliable check.
 */
async function checkCapture(timeoutMs: number): Promise<Check> {
  const name = 'Screen capture';
  let windows;
  try {
    windows = await listWindows(defaultOptions().windowOwner);
  } catch (error) {
    return { name, status: 'fail', detail: (error as Error).message };
  }

  const [target] = windows;
  if (!target) {
    return { name, status: 'warn', detail: 'skipped: no mirroring window to capture', hint: PERMISSION_HINT };
  }

  try {
    const image = await captureWindow(target, { timeoutMs });
    const { width, height } = pngSize(image);
    if (image.length < 1000) {
      return {
        name,
        status: 'warn',
        detail: `captured only ${image.length} bytes (${width}x${height}) — likely a blank permission placeholder`,
        hint: PERMISSION_HINT,
      };
    }
    return { name, status: 'ok', detail: `${width}x${height}px, ${Math.round(image.length / 1024)}KB` };
  } catch (error) {
    return { name, status: 'fail', detail: (error as Error).message, hint: PERMISSION_HINT };
  }
}

export async function runDoctor(argv: readonly string[] = []): Promise<number> {
  const options = defaultOptions();
  const backendArg = argv.find((arg) => arg.startsWith('--backend='))?.slice('--backend='.length);
  const backend = (backendArg ?? options.backend) as OcrBackendKind;
  const dryRun = argv.includes('--dry-run');

  const checks: Check[] = await Promise.all([
    checkNode(),
    checkBackend(backend, options.ocr.fixturePath),
    checkCliclick(dryRun),
    checkAccessibility(),
    checkWindow(options.windowOwner),
    checkFocus(options.windowOwner),
    checkDisplays(),
    checkCapture(options.captureTimeoutMs),
  ]);

  console.error('genie-as-a-service · doctor\n');
  for (const check of checks) {
    console.error(`${ICON[check.status]} ${check.name}: ${check.detail}`);
    if (check.hint && check.status !== 'ok') console.error(`    → ${check.hint}`);
  }

  const failed = checks.filter((check) => check.status === 'fail').length;
  if (failed === 0) {
    console.error('\nReady.');
  } else {
    console.error(`\n${failed} check(s) failed.`);
  }
  return failed === 0 ? 0 : 1;
}

const entry = process.argv[1];
const isEntryPoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isEntryPoint) {
  runDoctor(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error('[error]', error);
      process.exitCode = 1;
    });
}
