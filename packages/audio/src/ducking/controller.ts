/**
 * Ducking other applications while Riki speaks — and, on the primary platform, not doing so.
 *
 * ui-design.md §7.2 asks for −12 dB with a 120 ms ramp in and 250 ms out, "per-application where
 * the OS allows it". That hedge is now cashed out in
 * docs/research/audio-ducking-platform-support.md and the answer on macOS — the primary target
 * per ADR-0015 — is that the OS does not allow it at all. There is no public API by which one
 * application attenuates another's audio: `duckOthers` is `API_UNAVAILABLE(macos)`, Core Audio
 * exposes only the default device and our own stream, and every third-party tool that manages it
 * installs an audio HAL plug-in.
 *
 * **So the no-op path is the default, not a degradation** (ADR-0016). The consequence that drove
 * the design below: a sink that cannot duck is a *correct* sink. It does not log an error, does
 * not retry, and does not raise a fault — Riki speaking over un-ducked game audio is the normal
 * case on the platform most users are on. What it does do is report what it actually got, the
 * way `OverlayWindowController.setContentProtection` already does for the analogous
 * non-portable case (overlay-architecture.md §3.1), so settings can tell the truth rather than
 * offering a control that does nothing.
 */

import type { Decibels, Millis, Unsubscribe } from '../types.js';

/** Node's `process.platform` values, structurally. Passed in — this package reads no globals. */
export type Platform = 'darwin' | 'win32' | 'linux' | (string & {});

export type DuckingAvailability =
  /** Full control of depth and ramp. PipeWire/PulseAudio only. */
  | 'full'
  /**
   * The OS ducks, but chooses the depth and the ramp itself. Windows' communications-role
   * mechanism: ducking is a side effect of holding a comms stream, not a callable duck/unduck,
   * so ui-design.md §7.2's numbers are not achievable here either.
   */
  | 'system-controlled'
  /** No public API. macOS. */
  | 'unavailable';

export interface DuckingCapability {
  readonly availability: DuckingAvailability;
  /** Shown in settings when the control is disabled. One sentence, user-facing. */
  readonly reason: string;
  /** Whether §7.2's −12 dB / 120 ms / 250 ms are actually honoured. False on Windows. */
  readonly honoursRequestedDepth: boolean;
}

const CAPABILITIES: Readonly<Record<string, DuckingCapability>> = {
  darwin: {
    availability: 'unavailable',
    reason: 'macOS provides no public API for lowering another application’s volume.',
    honoursRequestedDepth: false,
  },
  win32: {
    availability: 'system-controlled',
    reason: 'Windows chooses the ducking depth and ramp; Riki cannot set them.',
    honoursRequestedDepth: false,
  },
  linux: {
    availability: 'full',
    reason: 'Ducking is applied per-stream through the audio server.',
    honoursRequestedDepth: true,
  },
};

/**
 * Unknown platforms get the macOS answer. Assuming a capability we have not verified would put a
 * live control in settings that silently does nothing, which is worse than one honestly absent.
 */
const UNKNOWN_PLATFORM: DuckingCapability = {
  availability: 'unavailable',
  reason: 'Ducking support on this platform has not been verified.',
  honoursRequestedDepth: false,
};

export function duckingCapability(platform: Platform): DuckingCapability {
  return CAPABILITIES[platform] ?? UNKNOWN_PLATFORM;
}

/** ui-design.md §7.2. Honoured only where `honoursRequestedDepth` is true. */
export const DUCK_DEPTH_DB: Decibels = -12;
export const DUCK_RAMP_IN_MS: Millis = 120;
export const DUCK_RAMP_OUT_MS: Millis = 250;

export interface DuckResult {
  /** False on every no-op path, including "the user turned ducking off". Never an error. */
  readonly applied: boolean;
  readonly availability: DuckingAvailability;
}

/**
 * The platform half. One implementation per backend; the controller below owns the policy that
 * is identical across all of them.
 */
export interface DuckingBackend {
  readonly availability: DuckingAvailability;
  apply(depthDb: Decibels, rampMs: Millis): void;
  release(rampMs: Millis): void;
  dispose(): void;
}

export interface DuckingController {
  /**
   * Emitted unconditionally by the interaction machine — overlay-architecture.md §8 is explicit
   * that the machine must not branch on a preference or a platform it should not have to hold.
   * All of that judgement is here.
   */
  duck(on: boolean): DuckResult;
  readonly capability: DuckingCapability;
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  onChange(fn: (result: DuckResult) => void): Unsubscribe;
  dispose(): void;
}

export interface DuckingOptions {
  readonly platform: Platform;
  /**
   * The user's setting (ui-design.md §11, "game ducking on/off"). Defaults to on, but on macOS
   * it is moot — `capability.availability` decides, and the settings row should be absent there
   * rather than present and inert.
   */
  readonly enabled?: boolean;
  /** Absent on the no-op path, which is the point: nothing is constructed that cannot work. */
  readonly backend?: DuckingBackend;
  readonly depthDb?: Decibels;
}

class PlatformDuckingController implements DuckingController {
  readonly capability: DuckingCapability;
  readonly #backend: DuckingBackend | null;
  readonly #depthDb: Decibels;
  readonly #listeners = new Set<(result: DuckResult) => void>();
  #enabled: boolean;
  #ducked = false;

  constructor(options: DuckingOptions) {
    this.capability = duckingCapability(options.platform);
    this.#enabled = options.enabled ?? true;
    this.#depthDb = options.depthDb ?? DUCK_DEPTH_DB;
    this.#backend =
      this.capability.availability === 'unavailable' ? null : (options.backend ?? null);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled || !this.#ducked) return;

    // Turning the setting off mid-duck must restore immediately, and it must go straight to the
    // backend: routing through `duck(false)` would take the no-op path — the setting is already
    // off by now — and the game would stay attenuated for the rest of the match.
    this.#ducked = false;
    this.#backend?.release(DUCK_RAMP_OUT_MS);
    this.#report({ applied: false, availability: this.capability.availability });
  }

  duck(on: boolean): DuckResult {
    const availability = this.capability.availability;
    const canApply = this.#backend !== null && this.#enabled;

    if (!canApply) {
      // The no-op path. Deliberately silent: no fault, no log, no retry.
      this.#ducked = false;
      return this.#report({ applied: false, availability });
    }

    if (on === this.#ducked) return this.#report({ applied: this.#ducked, availability });
    this.#ducked = on;

    if (on) this.#backend.apply(this.#depthDb, DUCK_RAMP_IN_MS);
    else this.#backend.release(DUCK_RAMP_OUT_MS);

    return this.#report({ applied: on, availability });
  }

  onChange(fn: (result: DuckResult) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  dispose(): void {
    if (this.#ducked) this.#backend?.release(0);
    this.#ducked = false;
    this.#backend?.dispose();
    this.#listeners.clear();
  }

  #report(result: DuckResult): DuckResult {
    for (const listener of this.#listeners) listener(result);
    return result;
  }
}

export function createDuckingController(options: DuckingOptions): DuckingController {
  return new PlatformDuckingController(options);
}
