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

import type { DebugIntent } from './debug.js';
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
 * The same allow-list discipline for the inspector, which has four things to say.
 *
 * It is checked at both boundaries for the same reason the overlay's is, and it matters more here
 * than anywhere else in the app: the inspector window is *focusable*, loads a document with a
 * scrollbar in it, and one of its four intents makes something happen.
 *
 * **This function decides shape, not authority.** `action` is normalised to `{id}` with the id
 * bounded, and that is all a boundary with no access to the registry can honestly check — whether
 * the id names a real scenario, and whether that scenario is already running, is main's question
 * and `DebugActionPort.run` is where it is asked. Splitting it that way is deliberate: a copy of the
 * registry here would be a second list to keep in step, and the weaker of the two checks would be
 * the one this file was trusted for.
 *
 * It used to have seven. ADR-0037's `control`/`reset-controls` and ADR-0038's `rehearse` are gone
 * with the trigger engine and the coaches they named (ADR-0042).
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

    // ADR-0039. Shape only — see the header.
    case 'action': {
      if (typeof candidate.id !== 'string' || candidate.id === '') return null;
      return { kind: 'action', id: candidate.id.slice(0, DEBUG_LIMITS.actionIdChars) };
    }

    case 'clear-trace':
      return { kind: 'clear-trace' };

    default:
      return null;
  }
}
