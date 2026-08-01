/**
 * The overlay's main-process surface: the window, where it is put, and what is pushed into it.
 *
 * This is the only part of the component that knows a renderer exists. The state that drives it
 * lives in main/session; see docs/design/overlay-architecture.md §5.
 *
 * Declarations only — implementations land with REPO_SKELETON.md §10 step 6, and not before the
 * anti-cheat spike (docs/runbooks/anticheat-validation.md) says this surface can exist at all.
 */

import type {
  LevelFrame,
  LevelSource,
  Millis,
  OverlayCommand,
  OverlayEnvironment,
  OverlayIntent,
  Unsubscribe,
} from '../../shared/overlay.js';
import type { OverlayEffectSink } from '../session/contracts.js';

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplaySnapshot {
  readonly id: number;
  readonly workArea: Rectangle;
  /**
   * OS display scaling. Deliberately *not* applied to the resolved bounds — Electron window
   * bounds are device-independent pixels — but it is what the chip scale defaults from, and the
   * renderer needs it to snap a 1 px hairline border to a device pixel.
   */
  readonly scaleFactor: number;
  /** Where the overlay lands when there is no full-screen app to follow (ui-design.md §9.2). */
  readonly primary: boolean;
}

/** Eight presets plus drag-to-place, stored per executable (ui-design.md §2.4). */
export type AnchorPreset =
  | 'top-left'
  | 'top-centre'
  | 'top-right'
  | 'middle-left'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-centre'
  | 'bottom-right';

export interface DragPlacement {
  readonly kind: 'drag';
  /** Fractions of the work area, so the placement survives a resolution change. */
  readonly xFraction: number;
  readonly yFraction: number;
}

export type ChipScale = 0.75 | 1 | 1.25 | 1.5;

/**
 * Prefer the display holding the Dota window — the capture sidecar already knows its bounds,
 * because capture is window-scoped (dota2 §7). Degrades to focus, then to primary; a hint that
 * has not arrived is not an error.
 *
 * `focused` carries bounds for the same reason `gameWindow` does: "focused" is a property of a
 * window, not of a display, and a resolver that cannot see the window has no way to answer.
 */
export type DisplayTargetHint =
  | { readonly kind: 'gameWindow'; readonly bounds: Rectangle }
  | { readonly kind: 'focused'; readonly bounds: Rectangle }
  | { readonly kind: 'primary' };

/** Pure geometry, so every anchor × scale × display case is a Tier 1 test (§5.4). */
export interface PlacementResolver {
  resolve(
    anchor: AnchorPreset | DragPlacement,
    display: DisplaySnapshot,
    scale: ChipScale,
  ): Rectangle;
  targetDisplay(
    displays: readonly DisplaySnapshot[],
    hint: DisplayTargetHint,
  ): DisplaySnapshot | null;
}

/** What `setContentProtection` actually achieved — it is not portable, and silence would lie. */
export interface CaptureExclusionResult {
  readonly requested: boolean;
  readonly applied: boolean;
  readonly reason?: string;
}

export interface OverlayWindowController {
  /**
   * Create, load, paint once, hide. Called at app start. The paint-once step is what makes
   * `showFast` a compositor map rather than a cold start — see §12 for the claim to verify.
   */
  warm(): Promise<void>;
  /** Synchronous `showInactive()`. No awaits, no allocation, nothing before it. */
  showFast(): void;
  /** After the hold, and cancelled if a `showFast()` arrives first — that is the anti-strobe rule. */
  hide(afterMs?: Millis): void;
  isVisible(): boolean;
  send(command: OverlayCommand): void;
  /** Levels ride their own channel so a 30 Hz stream never queues behind a model (§6.1). */
  sendLevel(frame: LevelFrame): void;
  /** One size per (anchor, scale, display). The chip animates inside it; the window does not. */
  applyPlacement(bounds: Rectangle, scale: ChipScale): void;
  setCaptureExcluded(on: boolean): CaptureExclusionResult;
  reload(): Promise<void>;
  onIntent(fn: (intent: OverlayIntent) => void): Unsubscribe;
  destroy(): void;
}

/** 30 Hz, coalesced, and stopped whenever the chip cannot show bars (§5.5). */
export interface LevelPump {
  start(source: LevelSource): void;
  stop(): void;
  isRunning(): boolean;
  onFrame(frame: LevelFrame): void;
}

export interface OverlayPresenter extends OverlayEffectSink {
  setEnvironment(env: OverlayEnvironment): void;
  pushLevel(frame: LevelFrame): void;
  onIntent(fn: (intent: OverlayIntent) => void): Unsubscribe;
  /** Fires after a reload or a crash; the runtime re-projects the current model. */
  onRendererReady(fn: () => void): Unsubscribe;
  dispose(): void;
}
