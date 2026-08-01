/**
 * Ducking other applications while Riki speaks — the interface, and the policy around it.
 *
 * Ducking is an operating-system call (WASAPI session volume and its equivalents), so the platform
 * implementations live in `apps/desktop/src/main`, where platform code belongs. This package
 * declares the shape so that `packages/audio` remains the one place the audio contract is stated
 * and so a Tier 1 test can drive a fake.
 *
 * −12 dB, 120 ms in, 250 ms out (ui-design.md §7.2). Without it, speech is unintelligible over
 * combat audio and the player stops using the feature; with it forced on, competitive players lose
 * footsteps. So it is disableable, and the disable check lives here rather than in the overlay's
 * machine — the machine emits the effect unconditionally (overlay-architecture.md §8).
 *
 * **On macOS — the primary target — there is no ducking at all** (ADR-0020,
 * docs/research/audio-ducking-platform-support.md): no public API exists for attenuating another
 * application's audio. `createNoopDucker()` is therefore the *default* path rather than a
 * fallback, and it is silent: no fault, no log, no retry. Riki speaking over un-ducked game audio
 * is the normal case, not a degradation.
 *
 * See docs/design/voice-input-architecture.md §4.4.
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

/** ui-design.md §7.2. Honoured where the platform allows it; intent everywhere else. */
export const DEFAULT_DUCKING: DuckingOptions = {
  amountDb: -12,
  rampInMs: 120,
  rampOutMs: 250,
  enabled: true,
};

/** Reports `available: false` and does nothing. The correct implementation where the OS has none. */
export function createNoopDucker(): Ducker {
  return {
    available: false,
    duck: () => Promise.resolve(),
    restore: () => Promise.resolve(),
  };
}

/**
 * What the overlay's `AudioEffectSink.duck(on)` becomes: the enabled check, the ramp figures, and
 * the state needed to avoid ramping twice.
 *
 * The machine emits `duck` unconditionally (overlay §8), so every judgement about whether anything
 * should actually happen is here.
 */
export interface DuckingSink {
  /** Never rejects. Resolves to whether an attenuation was actually applied. */
  set(on: boolean): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  readonly enabled: boolean;
  readonly available: boolean;
  /** Restores if ducked, so a crash mid-speech cannot leave the game quiet. */
  dispose(): Promise<void>;
}

export function createDuckingSink(
  ducker: Ducker,
  options: DuckingOptions = DEFAULT_DUCKING,
): DuckingSink {
  let enabled = options.enabled;
  let ducked = false;

  const restore = async (): Promise<void> => {
    ducked = false;
    await ducker.restore(options.rampOutMs);
  };

  return {
    get enabled() {
      return enabled;
    },
    get available() {
      return ducker.available;
    },

    async set(on: boolean): Promise<boolean> {
      // The no-op path, and on macOS the only path. Deliberately silent.
      if (!ducker.available || !enabled) return false;
      if (on === ducked) return ducked;

      if (on) {
        ducked = true;
        await ducker.duck(options.amountDb, options.rampInMs);
        return true;
      }
      await restore();
      return false;
    },

    async setEnabled(next: boolean): Promise<void> {
      if (next === enabled) return;
      enabled = next;
      if (next || !ducked) return;

      // Turning the setting off mid-duck must restore immediately, and it must call the ducker
      // directly. Routing through `set(false)` would take the disabled branch above — the setting
      // is already off by this point — and the game would stay attenuated for the rest of the
      // match with nothing in the UI to explain it.
      await restore();
    },

    async dispose(): Promise<void> {
      if (ducked) await restore();
    },
  };
}
