/**
 * The vocabulary the rest of this package speaks.
 *
 * See docs/design/voice-input-architecture.md §7.1. Declarations only.
 *
 * ⚠ Transitional, twice over.
 *
 * 1. The branded scalars belong to @riki/protocol per REPO_SKELETON.md §4; that package is step 2
 *    and still empty. `packages/world-model`, `packages/context` and `apps/desktop/src/shared`
 *    each declare their own copies for the same reason, and all of them collapse together then.
 * 2. `MicStream`, `OutboundTrack` and `RemoteTrack` are opaque here and are really
 *    `MediaStream` and `MediaStreamTrack`. Packages carry `lib: ["ES2023"]`, so DOM types cannot
 *    be named yet — the same wall `apps/desktop` hit (overlay-architecture.md §7.2). The
 *    DOM-typed constructors land with the voice window, when step 6 splits the app into
 *    per-surface projects; the interfaces below are what everything else depends on and they do
 *    not change when that happens.
 */

/** Local monotonic milliseconds. Never wall-clock: a level's age must not move when NTP steps. */
export type MonoMs = number & { readonly __brand: 'MonoMs' };

/** Every subscription in this package returns its own disposer. */
export type Unsubscribe = () => void;

/** Injected, so every envelope, ramp and silence window is deterministic in a Tier 1 test. */
export interface Clock {
  now(): MonoMs;
}

export type DeviceId = string & { readonly __brand: 'DeviceId' };

/** Ties a playback measurement to the response it measures. Opaque; the session owns the values. */
export type ResponseId = string & { readonly __brand: 'ResponseId' };
export type ItemId = string & { readonly __brand: 'ItemId' };

// -----------------------------------------------------------------------------------------------
// Opaque media handles (see the header)
// -----------------------------------------------------------------------------------------------

/** A live capture stream. Never crosses the preload bridge (ADR-0002, architecture §2.3). */
export interface MicStream {
  readonly id: string;
}

/** What the graph hands the transport. Also never crosses a process boundary. */
export interface OutboundTrack {
  readonly id: string;
}

/** Riki's own voice, coming back. The only output signal this package is allowed to analyse. */
export interface RemoteTrack {
  readonly id: string;
}

// -----------------------------------------------------------------------------------------------
// Measurement
// -----------------------------------------------------------------------------------------------

/**
 * One measurement of a signal. `rms` drives the chip's bars and the silence detection the
 * overlay's timers depend on; the display-side smoothing and quantisation are deliberately not
 * here (overlay-architecture.md §7.4 draws that line).
 */
export interface LevelSample {
  /** 0..1. */
  readonly rms: number;
  /** 0..1. */
  readonly peak: number;
  readonly at: MonoMs;
}

export type MicPermission = 'granted' | 'denied' | 'prompt';

/**
 * The audio half of the overlay's `FaultKind`. Kept to the two this package can actually observe —
 * everything else that can go wrong with voice is the session's (@riki/realtime).
 */
export type AudioFaultKind = 'mic-denied' | 'no-input-device';

export interface AudioFault {
  readonly kind: AudioFaultKind;
  /** Both of these persist: ui-design.md §8 keeps permission faults up until they are resolved. */
  readonly persistent: true;
  readonly message: string;
}
