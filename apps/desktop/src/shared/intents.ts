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
 * The same allow-list discipline for the inspector, which has exactly two things to say.
 *
 * It is checked at both boundaries for the same reason the overlay's is, and it matters slightly
 * more here: the inspector window is *focusable* and loads a document with a scrollbar in it, so
 * unlike the overlay it is a surface a person can interact with. Nothing it can send changes the
 * app's behaviour, and this function is where that stays true.
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

    default:
      return null;
  }
}
