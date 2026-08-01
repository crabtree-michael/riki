/**
 * The abstraction over "a microphone".
 *
 * These interfaces are deliberately DOM-free. `getUserMedia`, `MediaStream` and `AudioWorklet`
 * live in the voice window (ADR-0010), and an adapter there implements `AudioSourcePort` over
 * them. Keeping the vocabulary structural is what lets the whole capture pipeline below be a
 * Tier 1 test with no browser, no permission prompt and no device — which REPO_SKELETON.md §5.2
 * requires, since no test may need a real microphone.
 */

import type { Hertz, Millis, MonoFrame, Unsubscribe } from '../types.js';

/**
 * Local to this package on purpose. The interaction machine has its own `FaultKind`
 * (apps/desktop/src/main/session/types.ts) and mapping between them is the adapter's job — a
 * package that imported the app's enum would break the boundary rule that keeps this testable.
 */
export type AudioFaultKind =
  /** The user said no, or the OS did. Persistent: it does not resolve by retrying. */
  | 'mic-denied'
  /** Nothing to open. Also what an empty enumeration means. */
  | 'no-input-device'
  /** Opened once and went away — unplugged, or the OS took it. Recoverable by reopening. */
  | 'device-lost';

export interface AudioFault {
  readonly kind: AudioFaultKind;
  readonly message: string;
}

export interface CapturedChunk {
  readonly frame: MonoFrame;
  /** Monotonic, taken as close to the device callback as the adapter can manage. */
  readonly at: Millis;
}

export interface AudioSourcePort {
  /**
   * Whatever the device actually gave us. Never assumed to be 48 kHz: Chromium will hand back
   * the hardware rate, and on macOS that is routinely 44 100 for a laptop mic and 48 000 for an
   * interface. The resampler takes it as a parameter for exactly this reason.
   */
  readonly sampleRate: Hertz;
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(fn: (chunk: CapturedChunk) => void): Unsubscribe;
  onFault(fn: (fault: AudioFault) => void): Unsubscribe;
}

export interface AudioDeviceInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: 'input' | 'output';
  readonly isDefault: boolean;
}

export interface AudioDeviceEnumerator {
  list(): Promise<readonly AudioDeviceInfo[]>;
  onChanged(fn: () => void): Unsubscribe;
}

/** Where resampled, Realtime-rate audio goes. Implemented by @riki/realtime's session. */
export interface AudioChunkSink {
  append(frame: MonoFrame, at: Millis): void;
}
