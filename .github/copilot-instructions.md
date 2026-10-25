# Copilot Instructions — genie-as-a-service

A macOS-only TypeScript harness that drives an iOS app through **iPhone Mirroring** using
the OS UI layer only: `screencapture` → Apple Vision OCR → `cliclick`. No private Apple
APIs, no device pairing, no cloud calls.

## Hard constraints (do not break these)

- **Platform:** macOS with a live GUI session. This cannot run on Linux or in Docker — the
  hot path needs the WindowServer and TCC grants. Never suggest containerizing the harness;
  only `typecheck` and the offline test suite are containerizable.
- **Node:** `>=22 <24`. `.nvmrc` pins 22. The optional napi OCR module hard-caps below 24.
  Check with `node -v` before running anything; a global Node 16/24 will misbehave silently.
- **No new native dependencies** without a strong reason. Anything requiring `node-gyp` will
  fail on machines where `xcodebuild`/`xcrun` are broken (the common case here).
- **OCR must stay backend-agnostic.** All backends emit normalized **top-left-origin** boxes;
  only `toScreenText()` converts to screen points. Do not add per-backend coordinate math
  downstream.

## Layout

```
src/index.ts     Harness API, runStep/runScenario, CLI main, verification
src/window.ts    CGWindowListCopyWindowInfo via JXA, bounds cache, screencapture, PNG size
src/ocr.ts       macocr | napi | cli | replay backends, toScreenText, matchText, findText
src/executor.ts  cliclick wrapper: serialization, bounds guard, dry-run, accessibility check
src/scenario.ts  JSON step parsing and validation
src/config.ts    DEFAULTS, HARNESS_* env overrides, argv parsing, HELP text
src/doctor.ts    preflight: node, OCR, cliclick, accessibility, window, real capture
src/snapshot.ts  frame PNG + OCR/click JSON writer
src/types.ts     all shared types and HarnessError
```

## Code conventions

- **ESM with explicit `.js` extensions** in relative imports (`./types.js`), even in `.ts`
  files. `verbatimModuleSyntax` is on: use `import type { ... }` for types only.
- **Strict TypeScript** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  For optional properties use conditional spreads, not `x: undefined`:
  ```ts
  { action: 'click', ...(verify === undefined ? {} : { verify }) }
  ```
  Array/index access yields `T | undefined` — handle it.
- **All thrown errors are `HarnessError` with an `ErrorCode`** from `src/types.ts`. Add a new
  code rather than throwing a bare `Error`. Messages must say what to do next, not just what
  failed.
- **No `any`.** Use `unknown` + narrowing. `catch (error)` values are `unknown`.
- Prefer functions over classes; `Executor`, `Capturer`, `WindowLocator`, `Harness` are
  classes only because they hold state.
- Comments explain *why*, not *what*. Non-obvious trading decisions deserve one; a loop does
  not.

## Testing rules

- `npm run typecheck` and `npm test` must both pass before claiming work is done.
- Tests use `node:test` via `tsx` (`test/*.test.ts`). Pure logic (coordinates, matching,
  parsing, argv building) must stay testable **without** macOS permissions.
- The `replay` backend exists so the whole pipeline is exercisable offline; it supplies a
  synthetic frame and bypasses `screencapture`. Use it for new end-to-end tests.
- Tests that need a real window search for `Finder`/`Xcode`/`System Settings` and **skip
  themselves** when absent. Follow that pattern — never hard-fail on environment.
- Clicks in tests belong in `dryRun` mode. Tests must never move the user's mouse.

## The three traps in this codebase

These caused real bugs; preserve the safeguards.

1. **`cliclick` exits 0 when macOS blocks the event.** It only prints a stderr warning. Any
   code path that checks only the exit code will report success for a no-op click. The
   executor converts that warning into `CLICLICK_FAILED` — do not remove that check.
2. **A click can land on the right pixel and still do nothing** (occluded window, wrong
   focus, app ignoring it). `click` steps verify the screen changed and raise
   `STEP_FAILED ... the click was swallowed`. Steps that legitimately change nothing set
   `"verify": false`.
3. **`screencapture -l<id>` captures occluded windows**, so a successful capture does not
   mean the user can see it, and does not mean the app is frontmost. Never infer focus from
   capture success.
4. **An unfocused window swallows the first click.** macOS treats it as an activation click:
   the window comes forward and the control is never pressed. `Harness.focus()` activates the
   app before every click — do not remove it, and do not add a click path that skips it.
   A synthetic instant press can also be too fast for some apps; `pressMs` emits
   `dd:`/`w:`/`du:` instead of `c:`.
5. **OCR never sees icons.** Vision returns text boxes only. On a home screen the label is a
   caption *below* the icon, so clicking the label's center hits dead space and does nothing.
   Use `"target": "icon"` (offset = `ICON_OFFSET_LABEL_HEIGHTS` × label height) for
   home-screen grids; inside apps the default `text` target is right because the label *is*
   the control. Never hardcode a pixel offset — it must scale with the label.

## Coordinate contract

**All geometry is CoreGraphics space**: a single top-left origin anchored at the main display.
Windows on a secondary display ABOVE or LEFT of the main one have **negative** x/y. Window
bounds (`CGWindowListCopyWindowInfo`), `screencapture -R`, `cliclick`, and `CGEventPost` all
agree, so never convert between them. `NSScreen` is bottom-left per screen and WILL disagree
(`y = 982` vs `y = -1080` on this machine) — `src/displays.ts` converts it instead.

Window geometry is in **points**; the capture is in **pixels**; `scale = pixelWidth / window.width`
(2 on Retina). Vision returns fraction-of-image boxes.

```ts
screenX = window.x + (obs.x * pixelWidth) / scale
screenY = window.y + (obs.y * pixelHeight) / scale
center  = round(screenX + width / 2), round(screenY + height / 2)  // clamped to window
```

`mac-ocr` already reports top-left origins. `@cherrystudio/mac-system-ocr` reports
**bottom-left**, flipped once in its backend with `y' = 1 - (y + h)`.

`clickPoint(text, { target, offsetX, offsetY })` in `src/ocr.ts` is the only place that
decides where to click; keep it that way.

## Key combos and cliclick quirks

`cliclick`'s `kd:`/`ku:` accept **modifiers only** (`cmd`, `ctrl`, `alt`, `shift`, `fn`). A
digit there is rejected outright, so `kd:cmd,1` fails. Combos must hold the modifier and
*type* the character: `kd:cmd` → `t:1` → `ku:cmd`. `buildKeyArgs()` in `src/executor.ts` is
the only place that should construct these. `kp:num-1` is the **numpad**, not the top row, so
never use it for app shortcuts.

iPhone Mirroring's documented shortcuts: Cmd-1 Home Screen, Cmd-2 App Switcher, Cmd-3
Spotlight, Cmd-4 Control Center.

The App Switcher is a carousel: the foreground app renders **full-size**, neighbours are
scaled down. `segmentCards()` splits cards by x-gap projection; `locateForegroundCard()` picks
the **tallest** card. Do not reintroduce "most text" (Gmail's list beat Settings) or "nearest
the window centre" (the carousel pages, so the target can sit right of centre) — both were
measured failing on real frames. A card dismiss is a *flick*: slow drags snap back. Prefer the
`relaunch` action (quit + reopen the Mac app) over `forceQuit` when you need determinism.

## Verifying changes

```sh
npm run typecheck
npm test
npm run doctor                                    # needs a real terminal for TCC checks
HARNESS_WINDOW_OWNER=Finder npx tsx src/index.ts \
  --backend replay --fixture test/fixtures/settings-screen.json \
  --scenario scenarios/replay-demo.json --dry-run  # offline smoke test
```

`--dry-run` is mandatory when iterating on click logic. `--snapshot .shots` writes the frame
PNG plus the OCR/click JSON — that is the ground truth when diagnosing, so read the PNG
before theorizing about coordinates.

## Working in a sandbox

In a sandboxed agent environment, `screencapture` hangs and Vision fails with
`Failed to create CVPixelBuffer ... IOSurface`. That is an environment limit, not a code bug —
do not "fix" it. Attribute it clearly when reporting results, and validate via `replay` +
unit tests instead. Likewise, `brew install` and TCC changes are the user's job.

## Scope boundaries

Out of scope unless explicitly requested: Android, Windows, iOS-simulator control, scrolling
and swipe gestures, LLM-driven planning, multi-device mirroring, code signing/notarization.

When adding a scenario action, update **all** of: `Step` in `types.ts`, `parseStep` in
`scenario.ts`, `runStep` in `index.ts`, the action table in `README.md`, and a parse test.

When adding a scenario *field*, do the same plus forward it through `matchArgs` in
`index.ts` (an easy miss — the value parses but never reaches the harness).
