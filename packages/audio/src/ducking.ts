/**
 * Ducking other applications while Riki speaks — the interface only.
 *
 * Ducking is an operating-system call (WASAPI session volume and its equivalents), so the
 * implementations live in `apps/desktop/src/main`, where platform code belongs. This package
 * declares the shape so that `packages/audio` remains the one place the audio contract is stated
 * and so a Tier 1 test can drive a fake.
 *
 * −12 dB, 120 ms in, 250 ms out (ui-design.md §7.2). Without it, speech is unintelligible over
 * combat audio and the player stops using the feature; with it forced on, competitive players lose
 * footsteps. So it is disableable, and the disable check lives here rather than in the overlay's
 * machine — the machine emits the effect unconditionally (overlay-architecture.md §8).
 *
 * See docs/design/voice-input-architecture.md §4.4. Declarations only.
 */

export interface Ducker {
  /**
   * False is a legitimate answer — there is no per-application ducking on every platform we
   * target. Settings shows the control as unavailable rather than showing one that does nothing;
   * a ducker that claims an attenuation it did not achieve is the failure mode here.
   */
  readonly available: boolean;
  duck(amountDb: number, rampMs: number): Promise<void>;
  restore(rampMs: number): Promise<void>;
}

export interface DuckingOptions {
  readonly amountDb: number;
  readonly rampInMs: number;
  readonly rampOutMs: number;
  readonly enabled: boolean;
}

/** Reports `available: false` and does nothing. The correct implementation where the OS has none. */
export declare function createNoopDucker(): Ducker;
