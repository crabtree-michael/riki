/**
 * The chip's renderer-side contracts — the parts that are pure, and therefore the parts that can
 * be unit-tested without launching a window.
 *
 * Deliberately DOM-free. `apps/desktop/tsconfig.json` is a single project with `lib: ["ES2023"]`,
 * so renderer code cannot currently name `HTMLElement` at all (verified: `error TS2304`). The
 * view interfaces that need DOM types — ChipView, BarsView, GlyphView, TextSlot, CaptionPanel —
 * are specified in docs/design/overlay-architecture.md §7.2 and land as code when step 6 splits
 * this app into main / preload / renderer projects (§11.3).
 *
 * Declarations only.
 */

import type {
  AccentToken,
  ChipState,
  ChipViewModel,
  LevelFrame,
  Millis,
  MotionSignature,
  OverlayEnvironment,
  Unsubscribe,
} from '../../shared/overlay.js';

export interface OverlayApp {
  update(model: ChipViewModel): void;
  level(frame: LevelFrame): void;
  environment(env: OverlayEnvironment): void;
  dispose(): void;
}

/**
 * 30 fps, not the game's refresh rate — the bars carry nothing that needs 144 Hz
 * (ui-design.md §10). Stopped whenever the current signature is static.
 */
export interface AnimationClock {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  subscribe(fn: (tMs: Millis) => void): Unsubscribe;
  /** Dev and e2e only: the "idle costs literally nothing" assertion reads this (§10.4). */
  framesRendered(): number;
}

export interface MotionPreferences {
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
}

/** What one frame is allowed to change: transform and opacity, nothing else (§7.2). */
export interface MotionSample {
  readonly barScales: readonly number[];
  readonly opacity: number;
  readonly glyphScale: number;
}

export interface MotionDirector {
  /**
   * Reduced motion is a variant of every state, not a global off switch: the amplitude bars
   * carry real information and become a single static filled bar (ui-design.md §9.1).
   */
  signatureFor(state: ChipState, prefs: MotionPreferences): MotionSignature;
  /** Pure: same signature, same `t`, same level → same sample. */
  sample(signature: MotionSignature, tMs: Millis, level: number): MotionSample;
  /** Static signatures stop the clock rather than redrawing identical frames. */
  isStatic(signature: MotionSignature): boolean;
}

/**
 * @riki/audio owns the signal; the renderer owns the ballistics. RMS and the output envelope are
 * audio maths tested against known PCM; attack/decay smoothing and quantisation to five bars are
 * display decisions that change no audio behaviour (§7.4).
 */
export interface LevelBallistics {
  push(value: number, now: Millis): number;
  bars(level: number, count: number): readonly number[];
  reset(): void;
}

export type ChipToken = 'bg' | 'border' | 'shadow';

/**
 * Values live in tokens.css, not here. The lint rule in eslint.config.js rejects every hex
 * literal under renderer/**, with no exemption for the token module itself — a TypeScript module
 * holding `#6FD3FF` would be rejected by the rule that exists to protect it (§7.5).
 */
export interface TokenModule {
  cssVariable(token: AccentToken | ChipToken): string;
  contrastVariant(): 'normal' | 'high';
}
