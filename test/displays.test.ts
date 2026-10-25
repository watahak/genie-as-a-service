import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayFor, displaySignature, isOnDisplay, listDisplays } from '../src/displays.js';
import type { Display } from '../src/displays.js';

/** Mirrors the verified layout on this machine: external display ABOVE and LEFT. */
const MAIN: Display = { id: 0, x: 0, y: 0, width: 1512, height: 982, scale: 2, main: true };
const EXTERNAL: Display = { id: 1, x: -122, y: -1080, width: 1920, height: 1080, scale: 2, main: false };
const DISPLAYS = [MAIN, EXTERNAL];

const rect = (x: number, y: number, width = 354, height = 781) => ({ x, y, width, height });

describe('displayFor', () => {
  it('finds the main display for a window on it', () => {
    assert.equal(displayFor(rect(578, 185), DISPLAYS)?.id, 0);
  });

  it('finds the external display for a negative-coordinate window', () => {
    assert.equal(displayFor(rect(100, -900), DISPLAYS)?.id, 1);
  });

  it('picks the display with the largest overlap when a window straddles', () => {
    // Half on the main display's top edge, mostly on the external one.
    assert.equal(displayFor(rect(200, -700, 354, 781), DISPLAYS)?.id, 1);
    assert.equal(displayFor(rect(200, -200, 354, 781), DISPLAYS)?.id, 0);
  });

  it('returns undefined when the rect is on no display', () => {
    assert.equal(displayFor(rect(9999, 9999), DISPLAYS), undefined);
  });
});

describe('isOnDisplay', () => {
  it('accepts a window fully inside the main display', () => {
    assert.ok(isOnDisplay(rect(578, 185), MAIN));
  });

  it('accepts a window fully inside the external display', () => {
    assert.ok(isOnDisplay(rect(-100, -1000), EXTERNAL));
  });

  it('rejects a window that straddles the boundary', () => {
    assert.equal(isOnDisplay(rect(100, -100, 354, 781), MAIN), false);
  });

  it('rejects a main-display window evaluated against the external one', () => {
    assert.equal(isOnDisplay(rect(578, 185), EXTERNAL), false);
  });
});

describe('displaySignature', () => {
  it('encodes origin and size per display', () => {
    assert.equal(displaySignature(DISPLAYS), '0,0,1512x982|-122,-1080,1920x1080');
  });

  it('changes when a display is added', () => {
    assert.notEqual(displaySignature([MAIN]), displaySignature(DISPLAYS));
  });

  it('changes when a display is rearranged', () => {
    const moved = [{ ...MAIN }, { ...EXTERNAL, x: 1512, y: 0 }];
    assert.notEqual(displaySignature(DISPLAYS), displaySignature(moved));
  });
});

describe('listDisplays', () => {
  it('returns CoreGraphics-space displays with the main one first', async () => {
    const displays = await listDisplays();
    assert.ok(displays.length >= 1, 'expected at least one display');
    assert.equal(displays[0]?.main, true);
    assert.equal(displays[0]?.x, 0);
    assert.equal(displays[0]?.y, 0, 'the main display anchors the CG origin');

    for (const display of displays) {
      assert.ok(display.width > 0 && display.height > 0);
      assert.ok(display.scale >= 1);
    }

    // Any non-main display must not overlap the main display's origin.
    for (const display of displays.slice(1)) {
      assert.ok(
        display.x < 0 || display.y < 0 || display.x >= displays[0]!.width || display.y >= displays[0]!.height,
        `display #${display.id} overlaps the main display`,
      );
    }
  });
});
