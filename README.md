# genie-as-a-service

A local macOS automation harness that drives an iOS app through **iPhone Mirroring**
using only the OS UI layer:

```
screencapture ──► Apple Vision OCR ──► text match ──► cliclick
  (window)          (mac-ocr)                        (mouse/keyboard)
```

No private Apple APIs, no device pairing hacks, no cloud calls. Everything runs on-device.

## Requirements

| Requirement | Notes |
|---|---|
| macOS 15+ | iPhone Mirroring is required |
| Node.js **22** | `.nvmrc` pins it. Node 24 works with the default backend, but the optional napi backend needs `< 24` |
| `cliclick` | `brew install cliclick` |
| Xcode / Command Line Tools | Only needed for the optional napi OCR build; the default backend ships a prebuilt binary |
| Permissions | **Screen Recording** + **Accessibility** for your terminal |

## Setup

1. **Install cliclick**

   ```sh
   brew install cliclick
   ```

2. **Use Node 22**

   ```sh
   nvm install 22
   nvm use 22          # or: nvm use (reads .nvmrc)
   node -v             # v22.x
   ```

3. **Install dependencies**

   ```sh
   npm install
   ```

   `mac-ocr` downloads a prebuilt universal (arm64 + x86_64) Vision binary — no compiler needed.
   `@cherrystudio/mac-system-ocr` is an *optional* dependency; if its `node-gyp` build fails,
   install still succeeds and the napi backend is simply unavailable.

4. **Grant permissions**

   System Settings → Privacy & Security →
   - **Screen Recording** → enable for Terminal / iTerm / your editor
   - **Accessibility** → enable for the same app

   Quit and reopen the terminal afterwards; macOS only applies these on process start.

5. **Open iPhone Mirroring and connect your iPhone**, then leave the window visible
   (not minimized, not fully covered).

6. **Verify**

   ```sh
   npm run doctor
   ```

   ```
   ✓ Node.js: v22.x
   ✓ OCR backend (macocr): mac-ocr (Vision, prebuilt binary)
   ✓ cliclick: /opt/homebrew/bin/cliclick
   ✓ Window ("iPhone Mirroring"): id 8421 at 300,120 440x956pt
   ! Permissions: cannot be verified from the CLI
   ```

## Quick start

Try the offline demo first — it replays a fixture, so it needs no Screen Recording or
Accessibility permission. It still reads window geometry, so point it at any window you
have open:

```sh
HARNESS_WINDOW_OWNER=Finder npx tsx src/index.ts --backend replay \
  --fixture test/fixtures/settings-screen.json \
  --scenario scenarios/replay-demo.json --dry-run
```

```
[scenario] replay-demo (11 steps)
[1/11] find the Settings header ✓
[ocr] frame 2 → settings: Settings | Wi-Fi | General | Bluetooth | Display & Brightness
[dry-run] cliclick c:244,413
[3/11] open General ✓
...
```

Then a real run against the mirroring window:

```sh
npm run doctor                  # capture + Accessibility must both be ✓
npm run inspect                 # one frame + OCR dump, saved to .shots/ -- start here
npm run demo:watch              # visible run: cursor glides to each target
npm run demo                    # scenarios/demo.json
npm run demo -- --dry-run       # see the clicks without injecting them
npm run demo:verbose            # per-string OCR output + timings + snapshots
```

> Start with `--dry-run`. Confirm the coordinates look right before letting the harness
> take control of your mouse.

## Modules

| File | Responsibility |
|---|---|
| [src/window.ts](src/window.ts) | Locate the mirroring window via `CGWindowListCopyWindowInfo` (JXA), cache its bounds, capture it with `screencapture -l<id> -o -x`, fall back to `-R`, derive the Retina scale |
| [src/ocr.ts](src/ocr.ts) | OCR backends (`macocr` / `napi` / `cli` / `replay`), the single normalized→screen coordinate transform, and text matching |
| [src/executor.ts](src/executor.ts) | Serialized `cliclick` wrapper with a window-bounds guard and dry-run support |
| [src/index.ts](src/index.ts) | `Harness` API and scenario runner |
| [src/scenario.ts](src/scenario.ts) | JSON scenario parsing and validation |
| [src/doctor.ts](src/doctor.ts) | Preflight checks |
| [src/config.ts](src/config.ts) | Defaults, env overrides, CLI parsing |

### Window targeting

`src/window.ts` enumerates windows with `CGWindowListCopyWindowInfo` from inside
`osascript -l JavaScript`. That path avoids System Events, so it does not trigger an
Accessibility prompt just to find the window. The largest on-screen window owned by
`iPhone Mirroring` (layer 0) wins, and its geometry is cached for `HARNESS_GEOMETRY_TTL_MS`
(default 500 ms) so a perceive→act cycle makes at most one AppleScript round trip.

### OCR and coordinates

Vision reports text boxes as fractions of the image. The capture is in **pixels** while
window geometry is in **points**, so the transform is:

```js
scale   = pixelWidth / window.width          // 2 on Retina
screenX = window.x + (obs.x * pixelWidth) / scale
screenY = window.y + (obs.y * pixelHeight) / scale
center  = round(screenX + screenWidth / 2), round(screenY + screenHeight / 2)
```

Normalization happens **once**, in each backend, so this function serves all of them:

- `mac-ocr` already reports top-left-origin boxes → used as-is.
- `@cherrystudio/mac-system-ocr` reports bottom-left origins → flipped with `y' = 1 - (y + h)`.

Centers are clamped to the window so an overhanging Vision box can never produce a
click outside the target.

### Executor

Every command goes through one promise chain, so concurrent `await`s cannot interleave
mouse events. Each click is checked against the window rect first (`OUT_OF_BOUNDS`), which
catches a window that moved between capture and click. `--dry-run` logs instead of injecting.

## Scenarios

`scenarios/demo.json`:

```json
{
  "name": "demo",
  "steps": [
    { "action": "waitFor", "text": "Settings", "timeoutMs": 15000 },
    { "action": "click",   "text": "Settings" },
    { "action": "sleep",   "ms": 800 },
    { "action": "ocr",     "save": "home" },
    { "action": "type",    "text": "hello", "optional": true },
    { "action": "key",     "key": "return" }
  ]
}
```

### Actions

| Action | Fields | Behavior |
|---|---|---|
| `waitFor` | `text`, `mode`, `index`, `timeoutMs` | Poll capture+OCR until the text appears |
| `click` | `text`, `mode`, `index`, `timeoutMs`, `target`, `offsetX`, `offsetY`, `verify` | Wait, click, then confirm the screen changed (`verify: false` to skip) |
| `doubleClick` | same as `click` | Wait, then double-click |
| `tap` | `x`, `y` | Click an absolute screen point |
| `type` | `text` | Type into whatever has focus |
| `key` | `key` | Press a key or combo (`return`, `esc`, `cmd+1`, `cmd+shift+4`) |
| `home` | `expect`, `attempts` | Go to the Home Screen (Cmd-1); does **not** close the app |
| `forceQuit` | `settleMs`, `x` | Kill the foreground app: Cmd-1 → Cmd-2 → flick the **centred** card → Cmd-1 |
| `sleep` | `ms` | Pause |
| `ocr` | `save` | Dump every recognized string (and optionally label it) |

### Common step fields

| Field | Default | Meaning |
|---|---|---|
| `mode` | `exact` | `exact` \| `contains` \| `normalized` \| `regex` |
| `index` | `0` | Pick the n-th match when several share the text |
| `target` | `text` | `text` clicks the label; `icon` clicks the control above it |
| `offsetX` / `offsetY` | `0` | Nudge the click point, in screen points, after `target` is applied |
| `retry` | `0` | Extra attempts before the step fails |
| `optional` | `false` | Log a failure and continue instead of aborting |
| `timeoutMs` | `10000` | How long `waitFor`/`click` keep polling |
| `description` | auto | Label used in logs |

Matches are ranked by confidence, then by box area, so the most prominent candidate wins
when the same label appears twice.

## CLI

```
--scenario <file>     Run a JSON scenario
--backend <kind>      macocr (default) | napi | cli | replay
--fixture <file>      Observation fixture for the replay backend
--dry-run             Print clicks instead of injecting them
--slow                Vision accurate recognizer (default, more precise)
--fast                Vision fast recognizer (lower latency, misses short labels)
--languages <list>    Comma-separated BCP-47 codes, e.g. en-US,ja-JP
--min-confidence <n>  Noise floor when collecting observations (default 0.3)
--settle-ms <n>       Pause after each click
--profile             Print capture / OCR / click timings
--verbose             Print recognized text for every frame
--launch              Open iPhone Mirroring when its window is missing
--bench <n>           Time n capture+OCR cycles and report p50/p95
```

Environment: `HARNESS_BACKEND`, `HARNESS_WINDOW_OWNER`, `HARNESS_GEOMETRY_TTL_MS`,
`HARNESS_CAPTURE_TIMEOUT_MS`, `HARNESS_LANGUAGES`, `HARNESS_DRY_RUN=1`, `HARNESS_PROFILE=1`,
`HARNESS_VERBOSE=1`, `HARNESS_LAUNCH=1`, `CLICLICK_PATH`.

## Using it as a library

```ts
import { Harness } from './src/index.js';
import { defaultOptions } from './src/config.js';

const harness = new Harness({
  ...defaultOptions(),
  ocr: { fast: false, languages: ['en-US'], minConfidence: 0.3 },
  executor: { dryRun: false },
});

try {
  await harness.waitFor('Settings');
  await harness.clickText('Settings');
  await harness.typeText('hello');
  await harness.pressKey('return');

  const screen = await harness.screen();
  for (const item of screen.texts) {
    console.log(item.text, item.center);
  }
} finally {
  await harness.dispose();
}
```

## Performance

Latency per cycle is dominated by the two system calls, not by the TypeScript:

| Phase | Typical |
|---|---|
| `screencapture -l<id>` | 10–25 ms |
| Vision OCR (`fast`) | 15–40 ms |
| Vision OCR (accurate, default) | 60–150 ms |
| Text match | < 1 ms |
| `cliclick c:x,y` | 5–15 ms |

Use `--bench 20` to measure on your machine and `--profile` for per-frame numbers.
If you need to go faster: bound the search area with `--roi`-style cropping (not yet
exposed), reuse a single `screencapture` process, or switch to `fast` recognition with
`--fast` — but expect it to miss short labels (see below).

## Making OCR reliable

Vision's two recognition levels are **different algorithms, not a speed dial**, and the
difference matters for short UI labels:

- **accurate** (default) is a neural net that reads whole words and interpolates over
  ambiguous glyphs.
- **fast** reads one character at a time and drops short, hyphenated, or stylized
  strings.

Tracking the Settings screen across 24 consecutive frames showed the failure mode
plainly. With `fast`, the row value `Carrier_5G` was read every time while the label
`Wi-Fi` was returned **zero** times — even though the glyphs are 42 px tall, identical
to `Bluetooth`, which was read in all 24 frames. The row was not missed; Vision read the
value on the right of that same row and skipped the label on its left.

Dash characters are **not** the problem: `-` appears in 33 recorded observations, and
every dash it emitted was a plain hyphen-minus. Vision simply did not emit the `Wi-Fi`
token at all, so no amount of string-normalising could have recovered it.

There were two independent causes, and both are fixed by default — **nothing needs
configuring per label**:

1. **The accurate recognizer is the default.** `--fast` is opt-in and, when enabled,
   automatically re-runs a frame accurately if the fast pass returns fewer than
   `autoEscalate` boxes (default 6). Fast is worth it on dense screens and unsafe on
   sparse ones, so the harness decides per frame instead of per label.
2. **Confidence no longer vetoes a match.** `minConfidence` used to filter candidates
   during matching, so a low-confidence read of the exact string you asked for was
   converted into a misleading `TEXT_NOT_FOUND`. Confidence is now only used to *rank*
   matches; noise is suppressed once, when observations are collected.

`"mode": "normalized"` remains available for the rarer case where a recognizer returns a
*different dash codepoint* than you typed: it folds `-`, `‐`, `‑`, `–`, `—`, `−` and
ignores whitespace around separators, so `Wi-Fi`, `Wi - Fi` and `Wi‑Fi` all compare
equal.

If a label is still missing, prefer matching a **value** OCR reads reliably
(`Carrier_5G`) over a label it keeps skipping, or make the step `optional` when a
following step already verifies the same destination.

## Starting from a clean state

iPhone Mirroring resumes wherever the phone was left, so a second run can start inside a
submenu — or on the Action Button page — instead of where you expect.

Two actions, and the distinction matters:

| Action | What it does | Reliability |
|---|---|---|
| `home` | Presses **Cmd-1** to show the Home Screen | High |
| `forceQuit` | **Cmd-1** → **Cmd-2** → flick the centred card up and off → **Cmd-1** | High (see below) |

`home` alone is usually **not** enough: iOS keeps the app's navigation stack, so returning to
the Home Screen and reopening Settings *resumes* the previous page. To land on the root page
every run you need a real kill.

### Prefer `forceQuit`

```json
{ "action": "forceQuit" },
{ "action": "home" },
{ "action": "click", "text": "Settings", "target": "icon" }
```

`forceQuit` kills the iOS app and leaves the phone on the Home Screen, so the next launch
starts at the app's root page. It never touches the Mac-side iPhone Mirroring app: quitting
that app does not reliably work (it ignores the Apple event), and reopening it just
re-activates the same instance, so the phone stays wherever it was left.

### How `forceQuit` finds the right card

It doesn't look for one — it uses geometry.

1. **Cmd-1** returns to the Home Screen.
2. **Cmd-2** opens the App Switcher, which always opens on the **most recently used app**,
   rendered full-size in the centre.
3. The flick targets the window centre, starting low on the card (~83% down the window) and
   flinging past the top.

No OCR is involved, which is the point. Reading the card's title was the previous approach
and it failed on real frames: the centred card is often still blurred or completely blank, so
the only legible text belonged to a *background* card. Swiping that one dismissed nothing,
yet the frame still changed enough to look like success — so the app survived and the next
run started inside the same submenu.

Measured card geometry (`.shots/0030-f30.png`, window 354×781pt): the centred card spans
~18%..83% of the window height and is inset horizontally, so the grab point and the fling
distance are both derived from the window rect:

```ts
const top = window.y + window.height * 0.18;
const bottom = window.y + window.height * 0.83;
from = { x: centreX, y: bottom - (bottom - top) * 0.15 };
to   = { x: centreX, y: window.y + window.height * 0.02 };
```

Pass `x` only if the carousel is paged off-centre and you want to override the column:

```json
{ "action": "forceQuit", "x": 900 }
```

### Why the flick is still fragile

Dismissing a card is a *flick*, not a drag: a slow drag lets iOS snap the card back. The
gesture is a fast flick (~40–90 ms across 4–6 steps), attempted three times, getting faster
each time.

Every attempt is verified — if the frame is unchanged the flick was ignored and it retries,
then fails with:

```
forceQuit: the swipe did not dismiss the centred card after 3 attempts.
The App Switcher gesture is unreliable; retry with an explicit `x`,
or swipe the card away by hand.
```

`home` accepts `expect` + `attempts` to verify where it landed:

```json
{ "action": "home", "expect": "Settings", "attempts": 3 }
```

Shortcuts used (documented by Apple for iPhone Mirroring):

| Shortcut | Action |
|---|---|
| `Cmd-1` | Home Screen |
| `Cmd-2` | App Switcher |
| `Cmd-3` | Spotlight |
| `Cmd-4` | Control Center |

`key` and `type` steps activate the mirroring window first, so shortcuts reach the phone
rather than your editor.

## Clicking icons, not labels

**OCR never sees icons** — Vision returns text only. On an iOS home screen the label
`Settings` is a *caption beneath* a gear icon; clicking the label's center hits the empty
space between the icon and the text, so nothing happens.

Use `"target": "icon"` to aim at the control above the label:

```json
{ "action": "click", "text": "Settings", "target": "icon" }
```

The offset is `4.25 × the label's own height` (measured on a 2x mirroring capture: a 17px
label sits 73px below its icon center). Because it scales with the label, it works at any
resolution. Fine-tune with `offsetX` / `offsetY` if your device differs:

```json
{ "action": "click", "text": "Settings", "target": "icon", "offsetY": -4 }
```

This matters for home-screen grids and for anything where the tappable target is larger than
its text. Inside an app (a list row, a button with a visible title) the default `text` target
is correct — the label *is* the control.

### When the cursor lands but nothing is clicked

Two causes, both handled automatically:

1. **The window was not focused.** macOS delivers the first click to a background window as
   an *activation* click: the window comes forward, the control is never pressed, and the
   screen does not change. The harness activates the target app before every click
   (`[focus] activated "iPhone Mirroring"`); `doctor` reports whether activation works.
2. **The press was too short.** A synthetic instant press is sometimes ignored. Add a hold:

   ```sh
   npx tsx src/index.ts --scenario scenarios/demo.json --press-ms 80
   ```

   That issues `dd:x,y` → `w:80` → `du:x,y` instead of `c:x,y` — a real 80ms press.

If the click still does nothing, run with `--verbose`. You should see the cursor move, the
press, and then the verification verdict; if `cliclick` prints an Accessibility warning the
event was discarded before it reached any app.

## Watching clicks happen

Two things must be true before a click can reach the phone, and `npm run doctor` checks both:

```
✓ Accessibility: cursor at 1482,-535
✓ Screen capture: 708x1562px, 421KB
```

If either is ✗, nothing you run will touch the phone. This is the single most confusing
failure mode, because **`cliclick` exits `0` even when macOS blocks the event** — it only
prints a warning on stderr. The harness therefore:

1. treats that warning as a hard `CLICLICK_FAILED` error, and
2. verifies after every `click` that the screen actually changed, reporting
   `clicked "X" but the screen never changed; the click was swallowed` otherwise.

Set `"verify": false` on a step that legitimately changes nothing visible.

**Make the clicks visible:**

```sh
npm run demo:watch        # --show-motion --verbose
```

`--show-motion` moves the cursor to each target *before* clicking (and pauses 250 ms), so
you literally watch the pointer travel to `General` and click. Without it, `cliclick` warps
the pointer and clicks in the same instant — correct, but invisible.

`--verbose` relays cliclick's own narration, which also confirms each action really ran:

```
[ocr] "General" @ 244,413 (0.96)
[cliclick] Move to 244,413
[cliclick] Click at 244,413
[snapshot] .shots/0003-f3.png (+ .json)
[3/11] open General ✓
```

To confirm the phone responds, keep the iPhone Mirroring window visible beside the terminal
and watch the mirrored screen react. A fast single-frame blink is easy to miss, so
`--show-motion` is the recommended way to verify targeting.

> **Note:** the demo's *text* comes from `scenarios/demo.json`. If your home screen does not
> have a `Settings` icon in that exact position (or Settings opens somewhere else), step 1
> times out and nothing is clicked. Check `.shots/0001-f1.png` first — that PNG is exactly
> what the harness saw.

## Multiple displays

The harness uses **CoreGraphics** coordinates throughout: window bounds come from
`CGWindowListCopyWindowInfo` and clicks go through `cliclick` → `CGEventPost`. Both are in a
single space anchored at the **main display's top-left corner**, so a display arranged *above*
or *left of* the main one has **negative** coordinates:

```
main display      x=0    y=0      1512x982
external, above   x=-122 y=-1080  1920x1080
```

No conversion is applied, and none is needed — the window rect and the click target are in the
same space, so a window on the external display works the same as one on the main display.

Watch out if you ever compare against `NSScreen`: AppKit uses a **bottom-left origin per
screen**, so the same external display reads `y = 982` there instead of `-1080`. That
inverted sign is the classic cause of "clicks are off by the height of my monitor."
`src/displays.ts` converts `NSScreen` frames into CoreGraphics space for exactly this reason.

`npm run doctor` reports where the window is:

```
✓ Displays: window on #1 (secondary) at -100,-900; 2 display(s)
! Displays: window straddles displays (partly off #0)
```

If it reports a straddling window, drag it fully onto one screen — a click near the edge can
land on the other display.

## Diagnosing a failing step

`--verbose` prints every recognized string with the coordinate it would click, and
`--snapshot <dir>` writes both the frame PNG and a JSON file of the OCR result and click
targets. A snapshot is saved automatically whenever a step fails, so you can always see
exactly what the harness saw.

```sh
npm run inspect                       # capture + OCR once, write .shots/0001-f1.png|.json
npm run demo:verbose                  # full demo with per-frame snapshots
npx tsx src/index.ts --scenario scenarios/demo.json --verbose --snapshot .shots --dry-run
```

The failure message tells you which of the three problems it is:

| Message | Meaning |
|---|---|
| `OCR recognized no text at all` | Capture worked but returned nothing — window is blank, minimized, or Vision is unavailable |
| `no text matched exactly; retry with mode "contains" or "regex"` | Text exists but the query is a substring or has different punctuation |
| `Closest: "General"` | The nearest visible strings, ranked by bigram similarity — usually reveals a typo or a different label than expected |
| `no on-screen "iPhone Mirroring" window` | Capture never happened: the app is not running, or the window is minimized/off screen |
| `screencapture timed out` | Screen Recording is not actually granted for this terminal |
| `cliclick ran but macOS blocked the event` | Accessibility is not granted to the terminal running the harness |
| `clicked "X" but the screen never changed` | The click landed but the app ignored it — unfocused window (auto-handled), too-short press (`--press-ms 80`), or you clicked a label instead of its icon (`"target": "icon"`) |

The snapshot JSON looks like this — `observations` are the raw normalized boxes, `texts`
are the projected screen coordinates the executor used:

```jsonc
{
  "generation": 4,
  "window": { "x": 206, "y": 123, "width": 354, "height": 781 },
  "capture": { "pixelWidth": 708, "pixelHeight": 1562, "scale": 2 },
  "observations": [{ "text": "General", "confidence": 0.96, "x": 0.08, "y": 0.32, "width": 0.16, "height": 0.018 }],
  "texts": [
    {
      "text": "General",
      "confidence": 0.96,
      "bounds": { "x": 234.32, "y": 249.92, "width": 56.64, "height": 14.05 },
      "center": { "x": 263, "y": 257 }
    }
  ]
}
```

Use `--snapshot-all` to keep every frame instead of only failures (useful when a click
lands correctly but the *next* screen is unexpected).

### Why the demo's optional steps fail

`scenarios/demo.json` is written against a **stock iOS home screen and Settings app**, and
its later steps are marked `optional` precisely because their presence depends on your
device:

- `Wi-Fi` / `General` require Settings to be on its first page (iPhone Mirroring often opens
  to a different app, or Settings is inside a folder).
- `type` and `key` need a focused text field; on a plain Settings screen there is none, so
  `cliclick` types into nothing (harmless, but it will look like a no-op).
- Labels are matched **case-insensitively but exactly**, so `Display & Brightness` will not
  match `Display and Brightness`; use `"mode": "contains"` for that.

Open `.shots/` after a run — the PNG shows the truth, and the JSON shows what was matched.
If the fixture is fine but the labels differ, edit `scenarios/demo.json` to match what the
snapshot shows, and keep `"optional": true` on steps you are not sure about.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `screencapture produced no image. Grant Screen Recording…` | Terminal lacks Screen Recording. Enable it and restart the terminal |
| `screencapture timed out` | macOS is showing a permission prompt, or the display is asleep/locked |
| `cliclick not found` | `brew install cliclick`, or set `CLICLICK_PATH` |
| Clicks land in the wrong place | Run `--dry-run --verbose`; check the window is fully visible and not scaled. Mixed-DPI multi-monitor setups can confuse `screencapture -R`; window-ID capture avoids this |
| `OUT_OF_BOUNDS` | The window moved between capture and click. Lower `HARNESS_GEOMETRY_TTL_MS`, keep the window still, or check `doctor`'s Displays line |
| Clicks work on the laptop screen but not an external one | Window is on a display with negative coordinates; run `npm run doctor` and confirm the reported position is negative and fully inside one display |
| `no on-screen "iPhone Mirroring" window` | Open the app and connect the phone, or pass `--launch`. A minimized window is not on screen |
| OCR misses one short label | Noise floor is `minConfidence` (default 0.3); lower it with `--min-confidence 0`. A matched label is never rejected on confidence alone |
| `napi OCR … needs a node-gyp build` | Expected here: `xcodebuild`/`xcrun` are broken and the Xcode license is unaccepted. Use the default `macocr` backend |

### Notarization / first-run prompts

The first `screencapture` and `cliclick` run will each trigger a system permission
prompt. Approve them once per terminal app. If you switch terminals, grant permissions
again for the new one.

## Development

```sh
npm run typecheck   # tsc --noEmit, strict
npm test            # node:test via tsx, no permissions required
```

The test suite covers the coordinate transform (Retina, 1×, negative origins, overhanging
boxes), text matching (all modes, ranking, indexing), scenario validation, `cliclick`
argument building, dry-run execution and serialization, CLI/env parsing, and an
end-to-end `Harness` run through the `replay` backend.

Tests that need a real window look for `Finder`/`Xcode`/`System Settings` and skip
themselves when none is on screen.

## Limitations

- macOS only, and only while iPhone Mirroring exposes the app you care about.
- OCR is pixel-based, so it needs a stable, visible window. Nothing can interact with the
  phone while its screen is locked or the window is hidden.
- Typing requires focus; `type` sends keystrokes to whatever is focused in the mirrored phone.
- No built-in scrolling or swiping yet — `tap` plus `cliclick` drag primitives would be the
  next addition.
