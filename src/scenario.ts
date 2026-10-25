import { readFile } from 'node:fs/promises';
import { HarnessError } from './types.js';
import type { ClickTarget, MatchMode, PlannedStep, Scenario, Step } from './types.js';

const MATCH_MODES: readonly MatchMode[] = ['exact', 'contains', 'normalized', 'regex'];

function invalid(message: string): never {
  throw new HarnessError('SCENARIO_INVALID', message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) invalid(`${where}.${key} must be a non-empty string`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string, where: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${where}.${key} must be a number`);
  return value;
}

function optionalTarget(record: Record<string, unknown>, where: string): ClickTarget | undefined {
  const value = record['target'];
  if (value === undefined) return undefined;
  if (value !== 'text' && value !== 'icon') invalid(`${where}.target must be "text" or "icon"`);
  return value;
}

function optionalMatchMode(record: Record<string, unknown>, where: string): MatchMode | undefined {
  const value = record['mode'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MATCH_MODES.includes(value as MatchMode)) {
    invalid(`${where}.mode must be one of ${MATCH_MODES.join(' | ')}`);
  }
  return value as MatchMode;
}

/** Validates and converts one raw step into the discriminated {@link Step} union. */
export function parseStep(raw: unknown, index: number): PlannedStep {
  const where = `steps[${index}]`;
  const record = asRecord(raw, where);
  const action = requireString(record, 'action', where);
  const retry = optionalNumber(record, 'retry', where) ?? 0;
  const optional = record['optional'] === true;
  const description = typeof record['description'] === 'string' ? record['description'] : '';

  const optionalDescription = description === '' ? {} : { description };
  const textQuery = (): {
    text: string;
    mode?: MatchMode;
    index?: number;
    timeoutMs?: number;
    target?: ClickTarget;
    offsetX?: number;
    offsetY?: number;
  } => {
    const mode = optionalMatchMode(record, where);
    const stepIndex = optionalNumber(record, 'index', where);
    const timeoutMs = optionalNumber(record, 'timeoutMs', where);
    const target = optionalTarget(record, where);
    const offsetX = optionalNumber(record, 'offsetX', where);
    const offsetY = optionalNumber(record, 'offsetY', where);
    return {
      text: requireString(record, 'text', where),
      ...(mode === undefined ? {} : { mode }),
      ...(stepIndex === undefined ? {} : { index: stepIndex }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(target === undefined ? {} : { target }),
      ...(offsetX === undefined ? {} : { offsetX }),
      ...(offsetY === undefined ? {} : { offsetY }),
    };
  };

  let step: Step;
  switch (action) {
    case 'waitFor':
      step = { action: 'waitFor', ...textQuery(), ...optionalDescription };
      break;
    case 'click': {
      const verify = record['verify'];
      if (verify !== undefined && typeof verify !== 'boolean') invalid(`${where}.verify must be a boolean`);
      step = { action: 'click', ...textQuery(), ...(verify === undefined ? {} : { verify }), ...optionalDescription };
      break;
    }
    case 'doubleClick':
      step = { action: 'doubleClick', ...textQuery(), ...optionalDescription };
      break;
    case 'tap': {
      const x = optionalNumber(record, 'x', where);
      const y = optionalNumber(record, 'y', where);
      if (x === undefined || y === undefined) invalid(`${where} (tap) requires numeric x and y`);
      step = { action: 'tap', x, y, ...optionalDescription };
      break;
    }
    case 'type':
      step = { action: 'type', text: requireString(record, 'text', where), ...optionalDescription };
      break;
    case 'key':
      step = { action: 'key', key: requireString(record, 'key', where), ...optionalDescription };
      break;
    case 'home': {
      const expect = record['expect'];
      if (expect !== undefined && (typeof expect !== 'string' || expect.length === 0)) {
        invalid(`${where}.expect must be a non-empty string`);
      }
      const attempts = optionalNumber(record, 'attempts', where);
      if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1)) {
        invalid(`${where}.attempts must be a positive integer`);
      }
      step = {
        action: 'home',
        ...(expect === undefined ? {} : { expect }),
        ...(attempts === undefined ? {} : { attempts }),
        ...optionalDescription,
      };
      break;
    }
    case 'forceQuit': {
      const settleMs = optionalNumber(record, 'settleMs', where);
      if (settleMs !== undefined && settleMs < 0) invalid(`${where}.settleMs must be non-negative`);
      const x = optionalNumber(record, 'x', where);
      step = {
        action: 'forceQuit',
        ...(settleMs === undefined ? {} : { settleMs }),
        ...(x === undefined ? {} : { x }),
        ...optionalDescription,
      };
      break;
    }
    case 'sleep': {
      const ms = optionalNumber(record, 'ms', where);
      if (ms === undefined || ms < 0) invalid(`${where} (sleep) requires a non-negative ms`);
      step = { action: 'sleep', ms, ...optionalDescription };
      break;
    }
    case 'ocr': {
      const save = record['save'];
      if (save !== undefined && typeof save !== 'string') invalid(`${where}.save must be a string`);
      step = { action: 'ocr', ...(save === undefined ? {} : { save }), ...optionalDescription };
      break;
    }
    default:
      invalid(
        `${where}.action "${action}" is not supported ` +
          '(waitFor | click | doubleClick | tap | type | key | home | forceQuit | sleep | ocr)',
      );
  }

  if (!Number.isInteger(retry) || retry < 0) invalid(`${where}.retry must be a non-negative integer`);
  return { step, retry, optional, description: description || describeStep(step) };
}

/** Parses an already-decoded scenario document. */
export function parseScenario(raw: unknown): Scenario {
  const record = asRecord(raw, 'scenario');
  const name = requireString(record, 'name', 'scenario');
  const rawSteps = record['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) invalid('scenario.steps must be a non-empty array');

  const description = record['description'];
  if (description !== undefined && typeof description !== 'string') invalid('scenario.description must be a string');

  return {
    name,
    ...(typeof description === 'string' ? { description } : {}),
    steps: rawSteps.map((step: unknown, index: number) => parseStep(step, index)),
  };
}

/** Reads and parses a scenario file. */
export async function loadScenario(path: string): Promise<Scenario> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new HarnessError('SCENARIO_INVALID', `cannot read scenario ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HarnessError('SCENARIO_INVALID', `scenario ${path} is not valid JSON`, { cause: error });
  }
  return parseScenario(parsed);
}

/** Human-readable label used in logs and error messages. */
export function describeStep(step: Step): string {
  switch (step.action) {
    case 'waitFor':
      return `waitFor "${step.text}"`;
    case 'click':
      return `click "${step.text}"`;
    case 'doubleClick':
      return `doubleClick "${step.text}"`;
    case 'tap':
      return `tap ${step.x},${step.y}`;
    case 'type':
      return `type "${step.text}"`;
    case 'key':
      return `key ${step.key}`;
    case 'home':
      return step.expect ? `home (expect "${step.expect}")` : 'home';
    case 'forceQuit':
      return 'forceQuit (swipe out of App Switcher)';
    case 'sleep':
      return `sleep ${step.ms}ms`;
    case 'ocr':
      return step.save ? `ocr → ${step.save}` : 'ocr';
  }
}
