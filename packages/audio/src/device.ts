/**
 * Enumerating, opening and losing a microphone.
 *
 * The device is opened when a match starts and released when it ends, not once per key press
 * (ADR-0016): opening a capture device costs 50–300 ms, which is the whole ≤100 ms
 * key-down→visible budget, and there is nothing to pre-roll from a device that is not running.
 * Push-to-talk gates the graph in capture.ts instead.
 *
 * See docs/design/voice-input-architecture.md §3.1, §3.5.
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

// -----------------------------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------------------------

/**
 * `navigator.mediaDevices`, structurally.
 *
 * The package carries `lib: ["ES2023"]` so the DOM types cannot be named (see types.ts). Taking
 * this by injection is also what makes the registry a Tier 1 test: permission denial, an empty
 * device list and a mid-match unplug are three lines of fake each, and none of them is reachable
 * with a real device.
 */
export interface MediaDevicesLike {
  enumerate(): Promise<readonly AudioDeviceInfo[]>;
  /** Rejects with a `DOMException`-shaped value; `name` is what distinguishes the two faults. */
  getUserMedia(request: CaptureRequest): Promise<MicStream>;
  stop(stream: MicStream): void;
  onDeviceChange(listener: () => void): Unsubscribe;
  permission(): Promise<MicPermission>;
}

/** ADR-0016: opened per match. AEC is never false in the product path (realtime §11.5). */
export const DEFAULT_CAPTURE_REQUEST: CaptureRequest = {
  deviceId: null,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * An `AudioFault` that is also an `Error`.
 *
 * The contract says `open` "rejects with an `AudioFault`, never with a bare `Error`" — which is
 * about carrying the *kind*, not about refusing a stack trace. Extending `Error` satisfies both:
 * every declared field is present, and a permission failure ten minutes into a match arrives
 * somewhere diagnosable.
 */
export class AudioFaultError extends Error implements AudioFault {
  readonly kind: AudioFault['kind'];
  readonly persistent: true;

  constructor(kind: AudioFault['kind'], message: string) {
    super(message);
    this.name = 'AudioFaultError';
    this.kind = kind;
    // Both kinds persist: ui-design §8 keeps permission faults up until resolved, and §3.5 keeps
    // a missing device up because a voice coach with no microphone must not look idle.
    this.persistent = true;
  }
}

function faultFor(error: unknown): AudioFaultError {
  const name =
    typeof error === 'object' && error !== null ? String(Reflect.get(error, 'name')) : '';

  // Both persist: ui-design §8 keeps permission faults up until resolved, and a voice coach with
  // no microphone must not quietly look idle (§3.5).
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new AudioFaultError(
      'mic-denied',
      'Riki needs microphone access. Grant it in System Settings › Privacy & Security.',
    );
  }
  return new AudioFaultError('no-input-device', 'No microphone is available.');
}

export function createDeviceRegistry(media: MediaDevicesLike): DeviceRegistry {
  const faultListeners = new Set<(fault: AudioFault) => void>();

  const raise = <T extends AudioFault>(fault: T): T => {
    for (const listener of faultListeners) listener(fault);
    return fault;
  };

  return {
    list() {
      return media.enumerate();
    },

    permission() {
      return media.permission();
    },

    async open(request) {
      try {
        return await media.getUserMedia(request);
      } catch (error) {
        // "Rejects with an `AudioFault`, never with a bare `Error` — the chip needs the kind."
        throw raise(faultFor(error));
      }
    },

    close(stream) {
      media.stop(stream);
    },

    onChange(listener) {
      return media.onDeviceChange(() => {
        listener();
        // A departure that leaves at least one input is a swap, not a fault (§3.5). Only an
        // empty list is `no-input-device`, and finding that out costs an enumeration.
        void media
          .enumerate()
          .then((devices) => {
            if (!devices.some((device) => device.kind === 'input')) {
              raise(new AudioFaultError('no-input-device', 'The last input device was removed.'));
            }
          })
          .catch(() => {
            /* enumeration failing is not itself a device fault */
          });
      });
    },

    onFault(listener) {
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
  };
}
