/**
 * Enumerating, opening and losing a microphone.
 *
 * The device is opened when a match starts and released when it ends, not once per key press
 * (ADR-0016): opening a capture device costs 50–300 ms, which is the whole ≤100 ms
 * key-down→visible budget, and there is nothing to pre-roll from a device that is not running.
 * Push-to-talk gates the graph in capture.ts instead.
 *
 * See docs/design/voice-input-architecture.md §3.1, §3.5. Declarations only.
 */

import type { AudioFault, DeviceId, MicPermission, MicStream, Unsubscribe } from './types.js';

export interface AudioDeviceInfo {
  readonly id: DeviceId;
  readonly label: string;
  readonly kind: 'input' | 'output';
  readonly isDefault: boolean;
}

export interface CaptureRequest {
  /** `null` is the system default, which is what a fresh install uses. */
  readonly deviceId: DeviceId | null;
  /**
   * Never false in the product path. Without echo cancellation the model hears itself and
   * self-interrupts in a loop (realtime §11.5), which is the failure ADR-0001 chose Electron over
   * Tauri to avoid. It is a field rather than a constant so a test can prove the loop exists.
   */
  readonly echoCancellation: boolean;
  readonly noiseSuppression: boolean;
  readonly autoGainControl: boolean;
}

export interface DeviceRegistry {
  list(): Promise<readonly AudioDeviceInfo[]>;
  permission(): Promise<MicPermission>;
  /** Rejects with an `AudioFault`, never with a bare `Error` — the chip needs the kind. */
  open(request: CaptureRequest): Promise<MicStream>;
  close(stream: MicStream): void;
  /**
   * Device arrival and departure. A departure that leaves at least one input is a swap
   * (`CaptureGraph.replaceStream`), not a fault; only an empty list is `no-input-device`.
   */
  onChange(listener: () => void): Unsubscribe;
  onFault(listener: (fault: AudioFault) => void): Unsubscribe;
}
