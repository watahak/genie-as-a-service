import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Frame, RawObservation, ScreenText, Timing } from './types.js';

export interface SnapshotRecord {
  generation: number;
  savedAt: string;
  window: Frame['window'];
  capture: { pixelWidth: number; pixelHeight: number; scale: number };
  timing: Timing;
  /** Normalized 0..1 top-left boxes, exactly as the OCR backend returned them. */
  observations: RawObservation[];
  /** Projected absolute screen boxes, exactly as the executor would click them. */
  texts: ScreenText[];
}

export interface SnapshotPaths {
  image: string;
  json: string;
}

/**
 * Persists one frame plus its OCR result. The PNG shows what the harness saw and
 * the JSON shows where it would click, which is what diagnoses a failing step.
 */
export async function writeSnapshot(
  dir: string,
  frame: Frame,
  texts: readonly ScreenText[],
  observations: readonly RawObservation[],
  timing: Timing,
): Promise<SnapshotPaths> {
  await mkdir(dir, { recursive: true });

  const stem = `${String(frame.generation).padStart(4, '0')}-f${frame.generation}`;
  const image = join(dir, `${stem}.png`);
  const json = join(dir, `${stem}.json`);

  const record: SnapshotRecord = {
    generation: frame.generation,
    savedAt: new Date().toISOString(),
    window: frame.window,
    capture: { pixelWidth: frame.pixelWidth, pixelHeight: frame.pixelHeight, scale: frame.scale },
    timing,
    observations: observations.map((o) => ({
      text: o.text,
      confidence: o.confidence,
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
    })),
    texts: texts.map((t) => ({ text: t.text, confidence: t.confidence, bounds: t.bounds, center: t.center })),
  };

  await writeFile(image, frame.image);
  await writeFile(json, `${JSON.stringify(record, null, 2)}\n`);
  return { image, json };
}
