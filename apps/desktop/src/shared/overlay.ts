/**
 * The vocabulary the main process and the overlay renderer both speak.
 *
 * These are declarations only — no behaviour lands here. The design that gives them meaning is
 * docs/design/overlay-architecture.md; §6.3 explains why they are here rather than in
 * @riki/protocol.
 *
 * ⚠ Transitional home. `OverlayCommand`, `OverlayIntent` and `LevelFrame` cross a process
 * boundary, so per REPO_SKELETON.md §4 they belong in @riki/protocol as zod schemas. That
 * package is step 2 and is still empty. When it lands, those three become inferred types from
 * the schemas, this file re-exports rather than defines them, and the change is a coordination
 * event (the `protocol` skill). Everything else here — the chip's view model and the display
 * vocabulary — is app-internal and stays.
 */

/** Milliseconds on a monotonic clock. Never a wall-clock date; never compared across processes. */
export type Millis = number;

/** Every subscription in this component returns its own disposer. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------------------------
// What the chip can be (ui-design.md §3)
// ---------------------------------------------------------------------------------------------

/**
 * Seven, where there were nine.
 *
 * `acting` and `confirming` existed for exactly one producer each — a tool call slow enough to need
 * its own pixels, and the consent gate in front of `read_screen` — and ADR-0023 deleted both.
 * Nothing in the coaching path is slow enough to need pixels (brief assembly is in-process and
 * under 5 ms) and nothing needs consent. A state with no producer keeps its tests, keeps its colour
 * token and is never entered, so both went with their producers (coaching-architecture.md §7.2).
 */
export type ChipState =
  'hidden' | 'armed' | 'listening' | 'processing' | 'speaking' | 'error' | 'muted';

/** The four tray states (ui-design.md §2.3) — a coarser projection of the same machine. */
export type TrayGlyph = 'idle' | 'active' | 'muted' | 'attention';

/** Distinct per state, so colour is never the only channel (ui-design.md §4.3). */
export type GlyphId = 'dot' | 'dot-outline' | 'dot-segmented' | 'dot-ringed' | 'bang' | 'slashed';

/** Token *names*, never values. Values live in the renderer's tokens.css (§7.5). */
export type AccentToken = 'listening' | 'working' | 'speaking' | 'error' | 'muted';

/** Distinct per state, and independently sufficient to tell them apart (ui-design.md §4.3). */
export type MotionSignature =
  'none' | 'amplitude' | 'sweep' | 'envelope' | 'double-pulse-then-static';

export type BarMode = 'none' | 'input' | 'output' | 'sweep' | 'static';

/** Rendered as text, never as a control — the window is click-through (§1.1). */
export type Affordance = 'cancel' | 'fix';

export type ChipPhase = 'entering' | 'settled' | 'leaving';

export interface ChipText {
  /** Short. A fault in Error, an elapsed hint in Processing. Never a sentence. */
  readonly primary: string;
  /** Faded after the first two uses, then never shown again (ui-design.md §5.1). */
  readonly hint?: string;
  /**
   * How long it has been, at the moment this model was made. Set once the elapsed counter is due,
   * and the renderer ticks on from here (§7.2).
   *
   * A duration, deliberately, and not the timestamp it started at: `Millis` is main's monotonic
   * clock, which the renderer has no access to and must never try to compare against its own.
   */
  readonly elapsedMs?: Millis;
}

export interface CaptionModel {
  readonly you: string | null;
  readonly riki: string | null;
}

/** Everything the renderer needs to draw one frame of one state. Nothing else reaches it. */
export interface ChipViewModel {
  readonly state: ChipState;
  readonly phase: ChipPhase;
  readonly glyph: GlyphId;
  readonly accent: AccentToken;
  readonly motion: MotionSignature;
  readonly bars: BarMode;
  readonly text: ChipText | null;
  /** Tap-to-latch is on: a brighter border, so the two capture modes are never confused. */
  readonly latched: boolean;
  /** Silence has run past the nudge delay: bars flatten, chip dims to 60 %. */
  readonly dimmed: boolean;
  readonly affordances: readonly Affordance[];
  readonly captions: CaptionModel | null;
  /** Monotonic. The renderer drops a model or level frame older than the one it has drawn. */
  readonly revision: number;
}

/** Settings and OS conditions the view needs. Sent on connect and on change, not per frame. */
export interface OverlayEnvironment {
  readonly scale: 0.75 | 1 | 1.25 | 1.5;
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
  readonly captionsEnabled: boolean;
  readonly barCount: number;
}

export type LevelSource = 'input' | 'output';

export interface LevelFrame {
  readonly source: LevelSource;
  /** Normalised 0..1. RMS for input, output envelope for speaking — computed in @riki/audio. */
  readonly value: number;
  readonly at: Millis;
  readonly revision: number;
}

// ---------------------------------------------------------------------------------------------
// The bridge (§6.1) — the only messages that cross the preload boundary
// ---------------------------------------------------------------------------------------------

export type OverlayCommand =
  | { readonly kind: 'model'; readonly model: ChipViewModel }
  | { readonly kind: 'env'; readonly env: OverlayEnvironment }
  | { readonly kind: 'teardown' };

/**
 * The renderer's entire view of the outside world, exposed by the preload bridge as
 * `window.rikiOverlay`. Three functions, no escape hatches, no `ipcRenderer` (§6.2).
 *
 * Declared here rather than beside its implementation because the renderer has to name the type
 * and the implementation imports `electron` — a renderer that could reach that module would have
 * Electron in it, which is the thing `sandbox: true` and the lint boundary both exist to prevent.
 */
export interface RikiOverlayBridge {
  onCommand(fn: (command: OverlayCommand) => void): Unsubscribe;
  onLevel(fn: (frame: LevelFrame) => void): Unsubscribe;
  send(intent: OverlayIntent): void;
}

export type OverlayIntent =
  /** Mounted, or remounted after a crash: main re-projects the current model. */
  | { readonly kind: 'ready' }
  | { readonly kind: 'cancel' }
  /** First paint of a model revision. This is how the ≤100 ms budget is measured (§6.1). */
  | { readonly kind: 'paint'; readonly revision: number }
  /** The renderer has no logger and may not import @riki/telemetry; it reports through here. */
  | { readonly kind: 'fault'; readonly message: string };
