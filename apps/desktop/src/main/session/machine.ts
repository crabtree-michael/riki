/**
 * The interaction machine: a pure reducer plus two projections.
 *
 * No clock reads, no I/O, no randomness — `now` is an argument and everything time-driven is a
 * scheduled timer input. That is what makes the full state × input table a Tier 1 test with no
 * window and no Electron (docs/design/overlay-architecture.md §4, §13).
 *
 * The reducer never calls anything. It returns descriptions, and `SessionRuntime` performs them.
 */

import type {
  Affordance,
  AccentToken,
  ChipPhase,
  ChipState,
  ChipText,
  ChipViewModel,
  GlyphId,
  Millis,
  MotionSignature,
  BarMode,
  TrayGlyph,
} from '../../shared/overlay.js';
import type { MachineModule } from './contracts.js';
import {
  CANCEL_HINT_MS,
  ELAPSED_HINT_MS,
  ENTER_MS,
  ERROR_DISMISS_MS,
  HIDE_HOLD_MS,
} from './timing.js';
import type {
  ActingVerb,
  CaptureMode,
  ConfirmKey,
  Effect,
  EarconId,
  Fault,
  FaultKind,
  MachineEnvironment,
  MachineInput,
  MachineState,
  PendingTimer,
  Phase,
  TimerId,
  Transition,
  TriggerEvent,
  VoiceCommand,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

export function initial(env: MachineEnvironment, now: Millis): MachineState {
  return {
    phase: { kind: 'idle' },
    since: now,
    muted: false,
    latched: false,
    pending: [],
    reported: [],
    env,
    revision: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// The draft — a mutable working copy, so a transition reads as a sequence of statements
// ---------------------------------------------------------------------------------------------

interface Draft {
  phase: Phase;
  since: Millis;
  muted: boolean;
  latched: boolean;
  pending: PendingTimer[];
  reported: FaultKind[];
  env: MachineEnvironment;
  revision: number;
  readonly effects: Effect[];
}

function draftOf(state: Readonly<MachineState>): Draft {
  return {
    phase: state.phase,
    since: state.since,
    muted: state.muted,
    latched: state.latched,
    pending: [...state.pending],
    reported: [...state.reported],
    env: state.env,
    revision: state.revision,
    effects: [],
  };
}

function commit(d: Draft): Transition {
  const state: MachineState = {
    phase: d.phase,
    since: d.since,
    muted: d.muted,
    latched: d.latched,
    pending: d.pending,
    reported: d.reported,
    env: d.env,
    revision: d.revision,
    // A `window` effect that makes the overlay visible goes first: it is the only thing on the
    // 100 ms path (§4.1). Everything else keeps the order it was emitted in.
  };
  const show = d.effects.filter(isShow);
  const rest = d.effects.filter((e) => !isShow(e));
  return { state, effects: [...show, ...rest] };
}

function isShow(effect: Effect): boolean {
  return effect.kind === 'window' && effect.visible;
}

// --- effect emitters --------------------------------------------------------------------------

function show(d: Draft): void {
  d.effects.push({ kind: 'window', visible: true });
}

function hide(d: Draft): void {
  d.effects.push({ kind: 'window', visible: false, holdMs: HIDE_HOLD_MS });
}

function project(d: Draft): void {
  // The revision is the model's sequence number, so it advances exactly when a model is sent.
  d.revision += 1;
  d.effects.push({ kind: 'project' });
}

function levels(d: Draft, running: boolean, source: 'input' | 'output'): void {
  d.effects.push({ kind: 'levels', running, source });
}

function earcon(d: Draft, sound: EarconId): void {
  d.effects.push({ kind: 'earcon', sound });
}

function duck(d: Draft, on: boolean): void {
  d.effects.push({ kind: 'duck', on });
}

function keys(d: Draft, grab: readonly ConfirmKey[]): void {
  d.effects.push({ kind: 'keys', grab });
}

function voice(d: Draft, command: VoiceCommand): void {
  d.effects.push({ kind: 'voice', command });
}

function schedule(d: Draft, id: TimerId, delayMs: Millis, now: Millis): void {
  d.pending = [...d.pending.filter((t) => t.id !== id), { id, dueAt: now + delayMs }];
  d.effects.push({ kind: 'schedule', id, delayMs });
}

function cancel(d: Draft, id: TimerId): void {
  if (!d.pending.some((t) => t.id === id)) return;
  d.pending = d.pending.filter((t) => t.id !== id);
  d.effects.push({ kind: 'cancel', id });
}

function forget(d: Draft, id: TimerId): void {
  d.pending = d.pending.filter((t) => t.id !== id);
}

/**
 * Enter a phase. Cancels every pending timer except those explicitly kept, and runs the exit and
 * entry work that belongs to a phase rather than to any one edge — releasing the confirm keys,
 * and turning ducking on and off with Speaking.
 */
function enter(d: Draft, next: Phase, now: Millis, keep: readonly TimerId[] = []): void {
  const previous = d.phase;

  for (const timer of [...d.pending]) {
    if (!keep.includes(timer.id)) cancel(d, timer.id);
  }

  if (previous.kind === 'confirming' && next.kind !== 'confirming') keys(d, []);
  if (previous.kind === 'speaking' && next.kind !== 'speaking') duck(d, false);

  d.phase = next;
  d.since = now;

  if (next.kind === 'confirming' && previous.kind !== 'confirming')
    keys(d, ['yes', 'no', 'escape']);
  if (next.kind === 'speaking' && previous.kind !== 'speaking') duck(d, true);
}

// --- composite transitions --------------------------------------------------------------------

function beginCapture(d: Draft, gesture: CaptureMode, now: Millis): void {
  enter(d, { kind: 'armed', gesture }, now);
  d.latched = gesture === 'latch';
  show(d);
  // The pump starts here, not on entering Listening: the chip shows no bars while Armed, but the
  // meter has to be warm to hit the 250 ms "bars respond to voice" budget (ui-design.md §8).
  levels(d, true, 'input');
  earcon(d, 'capture-start');
  // Guards Armed as well as Listening — a mic that never opens must not hang here forever.
  schedule(d, 'listen-timeout', d.env.listenTimeoutMs, now);
  project(d);
}

function toProcessing(d: Draft, now: Millis, options: { readonly earcon: boolean }): void {
  enter(d, { kind: 'processing', startedAt: now }, now);
  levels(d, false, 'input');
  if (options.earcon) earcon(d, 'capture-end');
  schedule(d, 'elapsed-hint', ELAPSED_HINT_MS, now);
  schedule(d, 'cancel-hint', CANCEL_HINT_MS, now);
  project(d);
}

function toIdle(d: Draft, now: Millis): void {
  enter(d, { kind: 'idle' }, now);
  d.latched = false;
  levels(d, false, 'input');
  // Muted is the one exception to "zero pixels at rest": a static grey dot, because the absence of
  // any pixel would make the next key press indistinguishable from a crash (ui-design.md §3).
  if (d.muted) show(d);
  else hide(d);
  project(d);
}

function toListening(d: Draft, gesture: CaptureMode, now: Millis): void {
  enter(d, { kind: 'listening', gesture, silentSince: null }, now);
  d.latched = gesture === 'latch';
  show(d);
  levels(d, true, 'input');
  earcon(d, 'capture-start');
  schedule(d, 'listen-timeout', d.env.listenTimeoutMs, now);
  project(d);
}

/**
 * Barge-in: one transition, no intermediate state, and the chip changes before the truncate has
 * left the machine. The interaction already happened; the UI does not wait for the network to
 * acknowledge the user's own key press (§9.2).
 */
function bargeIn(d: Draft, gesture: CaptureMode, now: Millis): void {
  voice(d, { kind: 'interrupt', at: now });
  toListening(d, gesture, now);
}

function raiseFault(d: Draft, fault: Fault, now: Millis): void {
  // "Fail loudly, but only once" (ui-design.md §1.6). Deduping is scoped to persistent faults: a
  // denied mic must not re-announce itself every turn, but a second "didn't catch that" is news.
  const alreadyReported = fault.persistent && d.reported.includes(fault.kind);
  // Error is not "active": there is no capture to stop and no turn to abort.
  const wasActive = d.phase.kind !== 'idle' && d.phase.kind !== 'error';

  if (alreadyReported) {
    if (wasActive) toIdle(d, now);
    return;
  }

  if (fault.persistent) d.reported = [...d.reported, fault.kind];
  if (wasActive) voice(d, { kind: 'abort' });

  enter(d, { kind: 'error', fault }, now);
  d.latched = false;
  levels(d, false, 'input');
  earcon(d, 'error');
  show(d);
  if (!fault.persistent) schedule(d, 'error-dismiss', ERROR_DISMISS_MS, now);
  project(d);
}

function resolveConsent(d: Draft, granted: boolean, now: Millis): void {
  if (d.phase.kind !== 'confirming') return;
  voice(d, { kind: 'consent', promptId: d.phase.prompt.id, granted });
  // Either answer returns to Processing. Granted does not go straight to Acting: the tool's own
  // `tool.started` input owns that edge, so Acting has exactly one source (§4.4).
  enter(d, { kind: 'processing', startedAt: now }, now);
  schedule(d, 'elapsed-hint', ELAPSED_HINT_MS, now);
  schedule(d, 'cancel-hint', CANCEL_HINT_MS, now);
  project(d);
}

function cancelInteraction(d: Draft, now: Millis): void {
  if (d.phase.kind === 'idle') return;
  if (d.phase.kind === 'confirming') {
    // Esc is one of the grabbed confirm keys, so it denies — but it is also Esc, which
    // ui-design.md §3.1 defines as "return to Hidden without executing". Both, in that order: the
    // voice side is told the answer so it is not left waiting, and then the turn goes away. `N`
    // is the other answer, and it is deliberately different — it means "no, but carry on".
    voice(d, { kind: 'consent', promptId: d.phase.prompt.id, granted: false });
  }
  voice(d, { kind: 'abort' });
  toIdle(d, now);
}

// ---------------------------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------------------------

export function reduce(
  state: Readonly<MachineState>,
  input: MachineInput,
  now: Millis,
): Transition {
  const d = draftOf(state);
  apply(d, input, now);
  return commit(d);
}

function apply(d: Draft, input: MachineInput, now: Millis): void {
  switch (input.kind) {
    case 'trigger':
      applyTrigger(d, input.event, now);
      return;

    case 'intent':
      // The renderer's two acted-on intents are the same edges as the keyboard's.
      applyTrigger(d, input.intent, now);
      return;

    case 'capture':
      applyCapture(d, input.event, now);
      return;

    case 'speech':
      applySpeech(d, input.event, now);
      return;

    case 'turn':
      applyTurn(d, input.event, now);
      return;

    case 'tool':
      if (input.event === 'started') toActing(d, input.verb, now);
      else if (d.phase.kind === 'acting') toProcessing(d, now, { earcon: false });
      return;

    case 'consent':
      if (input.event === 'requested') toConfirming(d, input.prompt, now);
      else if (d.phase.kind === 'confirming') {
        // Resolved somewhere else — by voice, or by the session ending. No consent command: we
        // are being told the outcome, not deciding it.
        enter(d, { kind: 'processing', startedAt: now }, now);
        schedule(d, 'elapsed-hint', ELAPSED_HINT_MS, now);
        schedule(d, 'cancel-hint', CANCEL_HINT_MS, now);
        project(d);
      }
      return;

    case 'unprompted':
      // Idle → Speaking with no gesture behind it (§9.3). No Armed, and no earcon: the voice
      // starting is its own cue. Never while muted, and never on top of an active interaction.
      if (d.muted || d.phase.kind !== 'idle') return;
      enter(d, { kind: 'speaking', unprompted: true }, now);
      show(d);
      levels(d, true, 'output');
      project(d);
      return;

    case 'fault':
      raiseFault(d, input.fault, now);
      return;

    case 'mute':
      applyMute(d, input.muted, now);
      return;

    case 'settings':
      // Timers already running keep the delay they were scheduled with; the new values apply from
      // the next capture. Rescheduling mid-utterance would move the timeout under the user.
      d.env = input.env;
      project(d);
      return;

    case 'timer':
      applyTimer(d, input.id, now);
      return;
  }
}

function applyTrigger(d: Draft, event: TriggerEvent, now: Millis): void {
  if (event.kind === 'cancel') {
    cancelInteraction(d, now);
    return;
  }
  if (event.kind === 'confirm') {
    resolveConsent(d, event.answer, now);
    return;
  }

  // Muted suppresses every capture gesture. Cancel and confirm above still work, because they end
  // things rather than start them.
  if (d.muted) return;

  const gesture: CaptureMode = event.kind === 'tap' ? 'latch' : 'push';

  switch (d.phase.kind) {
    case 'idle':
      if (event.kind === 'down' || event.kind === 'tap') beginCapture(d, gesture, now);
      return;

    case 'armed':
      // Ending the gesture before any audio arrived: nothing was said, so nothing is submitted.
      if (endsGesture(d.phase.gesture, event.kind)) {
        earcon(d, 'capture-end');
        toIdle(d, now);
      }
      return;

    case 'listening':
      if (endsGesture(d.phase.gesture, event.kind)) toProcessing(d, now, { earcon: true });
      return;

    case 'speaking':
      if (event.kind === 'down' || event.kind === 'tap') bargeIn(d, gesture, now);
      return;

    case 'processing':
    case 'acting':
      // The player has something else to say. Drop the turn in flight rather than queueing behind
      // an answer they have stopped waiting for.
      if (event.kind === 'down' || event.kind === 'tap') {
        voice(d, { kind: 'abort' });
        beginCapture(d, gesture, now);
      }
      return;

    case 'confirming':
      // The only state that blocks. Y, N and Esc are the way out, and they are handled above.
      return;

    case 'error':
      // Pressing the key again is a retry, and it is the only recovery path the chip has: the
      // window is click-through, so `Fix ▸` is a hint and not a button. If the fault is still
      // there the next `fault` input is deduped, so the retry costs one silent return to Idle
      // rather than a second announcement — which is the whole of principle 1.6.
      if (event.kind === 'down' || event.kind === 'tap') beginCapture(d, gesture, now);
      return;
  }
}

/** Push ends on release; latch ends on the next tap. */
function endsGesture(gesture: CaptureMode, event: 'down' | 'up' | 'tap'): boolean {
  return gesture === 'push' ? event === 'up' : event === 'tap';
}

function applyCapture(d: Draft, event: 'opened' | 'firstAudio' | 'closed', now: Millis): void {
  switch (event) {
    case 'opened':
      // The device is open but nothing has arrived yet — still Armed, and still no bars.
      return;

    case 'firstAudio':
      if (d.phase.kind !== 'armed') return;
      // Audio is arriving, so whatever was broken is not broken now.
      d.reported = [];
      enter(d, { kind: 'listening', gesture: d.phase.gesture, silentSince: null }, now, [
        // The 8 s timeout spans Armed and Listening — it is time with no *speech*, not time
        // with no *phase change*, so it must survive this edge rather than restart on it.
        'listen-timeout',
      ]);
      project(d);
      return;

    case 'closed':
      // On the normal path the phase is already Processing by the time this arrives. Reaching it
      // while still capturing means the device went away under us.
      if (d.phase.kind !== 'armed' && d.phase.kind !== 'listening') return;
      earcon(d, 'capture-end');
      toIdle(d, now);
      return;
  }
}

function applySpeech(d: Draft, event: 'silence' | 'resumed', now: Millis): void {
  if (d.phase.kind !== 'listening') return;

  if (event === 'silence') {
    if (d.phase.silentSince !== null) return;
    d.phase = { ...d.phase, silentSince: now };
    // The dim is computed from `silentSince` at projection time; the timer exists to make a model
    // get sent at the moment it becomes true.
    schedule(d, 'silence-nudge', d.env.silenceNudgeMs, now);
    return;
  }

  if (d.phase.silentSince === null) return;
  d.phase = { ...d.phase, silentSince: null };
  cancel(d, 'silence-nudge');
  project(d);
}

function applyTurn(
  d: Draft,
  event: 'submitted' | 'responseStarted' | 'responseEnded',
  now: Millis,
): void {
  switch (event) {
    case 'submitted':
      // Server VAD can end a turn with the key still held (ADR-0017), so this is a second way into
      // Processing. No capture-end earcon: the mic has not closed.
      if (d.phase.kind === 'listening') toProcessing(d, now, { earcon: false });
      return;

    case 'responseStarted':
      if (d.phase.kind === 'idle' || d.phase.kind === 'speaking') return;
      d.reported = [];
      enter(d, { kind: 'speaking', unprompted: false }, now);
      show(d);
      levels(d, true, 'output');
      project(d);
      return;

    case 'responseEnded':
      if (d.phase.kind !== 'speaking') return;
      // A latched session is still open when Riki stops talking — that is what latching means, and
      // it is the "session active" affordance ui-design.md §13.5 asked for (§14).
      if (d.latched && !d.muted) toListening(d, 'latch', now);
      else toIdle(d, now);
      return;
  }
}

function toActing(d: Draft, verb: ActingVerb, now: Millis): void {
  if (d.phase.kind === 'idle' || d.phase.kind === 'confirming') return;
  enter(d, { kind: 'acting', verb }, now);
  show(d);
  // A tool call can outlast the hints Processing scheduled, so Acting re-arms them: a slow
  // `read_screen` must still grow an elapsed counter and surface `Esc ✕`.
  schedule(d, 'elapsed-hint', ELAPSED_HINT_MS, now);
  schedule(d, 'cancel-hint', CANCEL_HINT_MS, now);
  project(d);
}

function toConfirming(
  d: Draft,
  prompt: { readonly id: string; readonly question: string; readonly action: 'read-screen' },
  now: Millis,
): void {
  enter(d, { kind: 'confirming', prompt }, now);
  show(d);
  levels(d, false, 'input');
  // A consent prompt that waits forever is a consent prompt the player answers by alt-tabbing.
  schedule(d, 'confirm-timeout', d.env.confirmTimeoutMs, now);
  project(d);
}

function applyMute(d: Draft, muted: boolean, now: Millis): void {
  if (d.muted === muted) return;
  d.muted = muted;

  if (muted) {
    if (d.phase.kind !== 'idle') voice(d, { kind: 'abort' });
    toIdle(d, now);
    return;
  }

  // Unmuting only has a visible consequence at rest: the grey dot goes away.
  if (d.phase.kind === 'idle') {
    project(d);
    hide(d);
  }
}

function applyTimer(d: Draft, id: TimerId, now: Millis): void {
  forget(d, id);

  switch (id) {
    case 'silence-nudge':
      // Bars flatten and the chip dims to 60 % — both are read off `silentSince` at projection.
      if (d.phase.kind === 'listening' && d.phase.silentSince !== null) project(d);
      return;

    case 'listen-timeout':
      if (d.phase.kind !== 'armed' && d.phase.kind !== 'listening') return;
      raiseFault(
        d,
        { kind: 'no-speech-detected', persistent: false, message: "Didn't catch that" },
        now,
      );
      return;

    case 'elapsed-hint':
    case 'cancel-hint':
      if (d.phase.kind === 'processing' || d.phase.kind === 'acting') project(d);
      return;

    case 'error-dismiss':
      if (d.phase.kind === 'error' && !d.phase.fault.persistent) toIdle(d, now);
      return;

    case 'confirm-timeout':
      resolveConsent(d, false, now);
      return;

    case 'hide-hold':
      // Scheduled by the window controller, not by the machine: the hold travels on the `window`
      // effect because a `showFast()` arriving mid-hold has to cancel it, and only the controller
      // sees that. Listed here so the exhaustive switch stays exhaustive.
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------------------------

/**
 * Hidden is absent from this map: it is not a phase, it is Idle without the muted condition.
 * Everything else is one-to-one, and the three tables below are keyed off it so "every state has
 * a distinct glyph" can be asserted over the enum rather than over the reducer.
 */
export function chipStateOf(state: Readonly<MachineState>): ChipState {
  switch (state.phase.kind) {
    case 'idle':
      return state.muted ? 'muted' : 'hidden';
    default:
      return state.phase.kind;
  }
}

/** ui-design.md §4.3 — independently sufficient to tell the states apart without colour. */
export const GLYPHS: Readonly<Record<ChipState, GlyphId>> = {
  hidden: 'dot-outline',
  armed: 'dot-outline',
  listening: 'dot',
  processing: 'dot-segmented',
  acting: 'gear',
  confirming: 'query',
  speaking: 'dot-ringed',
  error: 'bang',
  muted: 'slashed',
};

/** Token names only. The values live in the renderer's tokens.css (ui-design.md §4.2). */
export const ACCENTS: Readonly<Record<ChipState, AccentToken>> = {
  hidden: 'muted',
  armed: 'listening',
  listening: 'listening',
  processing: 'working',
  acting: 'working',
  confirming: 'confirm',
  speaking: 'speaking',
  error: 'error',
  muted: 'muted',
};

/**
 * ui-design.md §4.3. Acting shares Processing's signature on purpose — it is "as Processing, plus
 * a verb" — so motion alone does not separate all nine states. The pair (glyph, motion) does, and
 * that is what the exhaustive test asserts.
 */
export const MOTIONS: Readonly<Record<ChipState, MotionSignature>> = {
  hidden: 'none',
  armed: 'none',
  listening: 'amplitude',
  processing: 'sweep',
  acting: 'sweep',
  confirming: 'none',
  speaking: 'envelope',
  error: 'double-pulse-then-static',
  muted: 'none',
};

const BARS: Readonly<Record<ChipState, BarMode>> = {
  hidden: 'none',
  armed: 'none',
  listening: 'input',
  processing: 'sweep',
  acting: 'sweep',
  confirming: 'none',
  speaking: 'output',
  error: 'none',
  muted: 'none',
};

const ACTING_LABELS: Readonly<Record<ActingVerb, string>> = {
  reading: 'reading screen…',
  'looking-up': 'looking up…',
  checking: 'checking…',
};

export function projectChip(state: Readonly<MachineState>, now: Millis): ChipViewModel {
  const chipState = chipStateOf(state);
  return {
    state: chipState,
    phase: chipPhase(state, chipState, now),
    glyph: GLYPHS[chipState],
    accent: ACCENTS[chipState],
    motion: MOTIONS[chipState],
    bars: BARS[chipState],
    text: chipText(state, now),
    latched: state.latched,
    dimmed: isDimmed(state, now),
    affordances: affordancesOf(state, now),
    // Caption *text* is not machine state — the overlay holds no conversation state (§1.1), and
    // the redacted strings arrive with the adapters. The setting reaches the view as environment.
    captions: null,
    revision: state.revision,
  };
}

function chipPhase(state: Readonly<MachineState>, chipState: ChipState, now: Millis): ChipPhase {
  if (chipState === 'hidden') return 'leaving';
  return now - state.since < ENTER_MS ? 'entering' : 'settled';
}

function isDimmed(state: Readonly<MachineState>, now: Millis): boolean {
  if (state.phase.kind !== 'listening') return false;
  const { silentSince } = state.phase;
  return silentSince !== null && now - silentSince >= state.env.silenceNudgeMs;
}

function chipText(state: Readonly<MachineState>, now: Millis): ChipText | null {
  switch (state.phase.kind) {
    case 'acting':
      return { primary: ACTING_LABELS[state.phase.verb] };

    case 'confirming':
      return { primary: state.phase.prompt.question, hint: '[Y] yes   [N] no' };

    case 'error':
      return state.phase.fault.persistent
        ? { primary: state.phase.fault.message, hint: 'Fix ▸' }
        : { primary: state.phase.fault.message };

    case 'processing': {
      // A duration rather than a running number: the renderer ticks it locally once a second, so
      // main does not re-project every second just to advance a digit (§7.2).
      const elapsed = now - state.phase.startedAt;
      if (elapsed < ELAPSED_HINT_MS) return null;
      return { primary: '', elapsedMs: elapsed };
    }

    default:
      // Speaking's `⌥Space ✕` hint is deliberately absent: rendering it means naming the bound
      // key, which the machine does not know — trigger/ owns the binding, and it is a sibling
      // task. Left open in §14 rather than guessed at here.
      return null;
  }
}

function affordancesOf(state: Readonly<MachineState>, now: Millis): readonly Affordance[] {
  switch (state.phase.kind) {
    case 'confirming':
      return ['confirm'];
    case 'error':
      return state.phase.fault.persistent ? ['fix'] : [];
    case 'processing':
      return now - state.phase.startedAt >= CANCEL_HINT_MS ? ['cancel'] : [];
    case 'acting':
      return now - state.since >= CANCEL_HINT_MS ? ['cancel'] : [];
    default:
      return [];
  }
}

/**
 * Nine states collapse to four (ui-design.md §2.3).
 *
 * Attention is read off `reported`, not off the current phase, and that is the point: a revoked
 * microphone outlives the four seconds of Error chip, and the tray is the surface that has to keep
 * saying so until it is fixed. It also outranks muted — the permission still needs attention
 * whether or not the user has additionally switched Riki off.
 */
export function projectTray(state: Readonly<MachineState>): TrayGlyph {
  if (state.reported.length > 0) return 'attention';
  if (state.muted) return 'muted';
  if (state.phase.kind === 'idle') return 'idle';
  return 'active';
}

/** The pure core, as the object `SessionRuntime` takes by injection. */
export const machine: MachineModule = { initial, reduce, projectChip, projectTray };
