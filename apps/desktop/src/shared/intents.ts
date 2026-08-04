/**
 * The allow-list for everything the renderer is allowed to say.
 *
 * One definition, checked at two boundaries. The preload copy stops a renderer *bug* from reaching
 * IPC at all; main's copy stops a compromised renderer from reaching the interaction machine. The
 * renderer is the least privileged process in the app and its output is treated as untrusted
 * input (docs/design/overlay-architecture.md §6.2).
 *
 * Returns a freshly built object rather than the input: nothing the renderer attached beyond these
 * fields survives the crossing.
 */

import type { DebugControlValue, DebugIntent } from './debug.js';
import { DEBUG_LIMITS } from './debug.js';
import type { OverlayIntent } from './overlay.js';

/** Long enough to be a useful diagnostic, short enough not to be a log-flooding vector. */
const MAX_FAULT_MESSAGE = 500;

export function parseOverlayIntent(payload: unknown): OverlayIntent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Record<string, unknown>;

  switch (candidate.kind) {
    case 'ready':
      return { kind: 'ready' };

    case 'cancel':
      return { kind: 'cancel' };

    case 'paint':
      return typeof candidate.revision === 'number' && Number.isFinite(candidate.revision)
        ? { kind: 'paint', revision: candidate.revision }
        : null;

    case 'fault':
      return typeof candidate.message === 'string'
        ? { kind: 'fault', message: candidate.message.slice(0, MAX_FAULT_MESSAGE) }
        : null;

    default:
      return null;
  }
}

export function isOverlayIntent(payload: unknown): payload is OverlayIntent {
  return parseOverlayIntent(payload) !== null;
}

/**
 * The same allow-list discipline for the inspector, which has five things to say.
 *
 * It is checked at both boundaries for the same reason the overlay's is, and it matters more here
 * than anywhere else in the app: the inspector window is *focusable*, loads a document with a
 * scrollbar in it, and since ADR-0037 two of its four intents change what the coach does.
 *
 * **This function decides shape, not authority.** `control` is normalised to `{id, value}` with
 * both bounded, and that is all a boundary with no access to the registry can honestly check —
 * whether the id names a real control, and whether that control is locked, is main's question and
 * `DebugControlPort.apply` is where it is asked. Splitting it that way is deliberate: a copy of the
 * registry here would be a second list to keep in step, and the weaker of the two checks would be
 * the one this file was trusted for.
 */
export function parseDebugIntent(payload: unknown): DebugIntent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Record<string, unknown>;

  switch (candidate.kind) {
    case 'ready':
      return { kind: 'ready' };

    case 'fault':
      return typeof candidate.message === 'string'
        ? { kind: 'fault', message: candidate.message.slice(0, MAX_FAULT_MESSAGE) }
        : null;

    case 'control': {
      if (typeof candidate.id !== 'string' || candidate.id === '') return null;
      const value = controlValue(candidate.value);
      if (value === null) return null;
      return { kind: 'control', id: candidate.id.slice(0, DEBUG_LIMITS.controlIdChars), value };
    }

    case 'reset-controls':
      return { kind: 'reset-controls' };

    case 'rehearse':
      // Same split as `control`: a name and a bound are all a boundary with no library can check.
      // Whether the id names a mock state that exists is main's question, and a `rehearse` naming
      // one that does not becomes an `inspector` problem rather than a silence.
      return typeof candidate.stateId === 'string' && candidate.stateId !== ''
        ? { kind: 'rehearse', stateId: candidate.stateId.slice(0, DEBUG_LIMITS.mockIdChars) }
        : null;

    default:
      return null;
  }
}

/**
 * A control's value, or null for anything that is not one of the three shapes.
 *
 * `NaN` and the infinities are refused rather than clamped. They arrive from a stepper that
 * divided by something, they would reach a threshold comparison as a value that is neither above
 * nor below it, and the resulting silence would be indistinguishable from a working gate.
 */
function controlValue(raw: unknown): DebugControlValue | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') return raw.slice(0, DEBUG_LIMITS.controlValueChars);
  return null;
}
