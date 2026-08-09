/**
 * The composition root's voice half — voice-input-architecture.md §7.3, and the thing that
 * replaces `shell/silent-session.ts`.
 *
 * It is a `VoiceSessionPort`, so the turn agent above it cannot tell the difference between this
 * and the stand-in. What it adds underneath is everything: `@riki/config` yields the key,
 * `ClientSecretBroker` mints from it, the voice window is created and handed the secret plus the
 * session config, and `VoiceEvent`s come back the other way.
 *
 * ## What this file is careful about
 *
 * **The key never leaves this process.** `ApiKey` goes into `ClientSecretBroker` and nothing else;
 * what crosses the bridge is a short-lived client secret (ADR-0015). `schemas/voice.ts` has no
 * field that could carry a key, and a test asserts that as a shape.
 *
 * **Turn ids are allocated here.** `beginTurn` is synchronous — the overlay's ≤100 ms budget
 * forbids an await between the key press and the window being shown — so it cannot wait for a
 * renderer to answer with one. It allocates, sends, and returns in the same tick.
 *
 * **Nothing is sent before the renderer says it is listening.** A directive sent before
 * `voice.ready` is a message with no listener and produces a session that never opens and never
 * errors. Directives queue until then, so the caller does not have to know.
 *
 * **A failure is a fault on the chip, never a rejected promise.** `speakNow` and `endTurn` resolve
 * to "handed over", not to "finished speaking" — the chip leaves Speaking on the event stream — so
 * rejecting them would leave the overlay claiming Riki is talking forever. That is the one
 * confusion `silent-session.ts` was written to avoid, and it is just as easy to reintroduce here.
 *
 * ## The tool call is the one message that comes back the other way — T12
 *
 * Everything else here is main telling the renderer something. `voice.tool.call` is the renderer
 * asking main a question, because the model's five tools read a `WorldState` and only this process
 * may hold one (ADR-0002, ADR-0015). Before T12 there was no such message, so nothing injected a
 * `ToolDispatcher`, so `packages/realtime` sent `tools: []` and a live session had no tools at all
 * — everything ADR-0042, T3, T4, T6 and T9 built was invisible in a real match. That was found by
 * a player, not by a test, which is what the round trip in `session.test.ts` is for.
 *
 * `answerToolCall` below is the far end. Its one rule is `packages/realtime`'s rule: a call is
 * answered whatever happens, because the answer lands in a sentence that is already being spoken.
 *
 * ## Renewal — ADR-0045
 *
 * The Realtime API closes a session at 60 minutes. A Dota match plus draft plus post-game passes
 * that regularly, and on 2026-08-09 it did: `session_expired`, the data channel closed, ICE
 * disconnected, and nothing reconnected for the rest of the match.
 *
 * Renewal is here rather than in `packages/realtime` for one reason: a new session needs a new
 * client secret, minting needs the `ApiKey`, and the key is in this process and stays here
 * (ADR-0015). The renderer's `CredentialPort` resolves the constant it was handed. So main mints
 * and sends `voice.session.open` again, and the voice window's handler — which already closes the
 * live session before opening a new one — does the rest. There is no new message and no new
 * mechanism.
 *
 * Three properties this file owes:
 *
 * 1. **Before the cap, not after it.** A timer at `DEFAULT_RENEW_AFTER_MS` (50 minutes) renews
 *    while the old session still works. The reactive path is the backstop for a session that dies
 *    early, not the plan.
 * 2. **One renewal per loss.** The expiry arrives as an error *and* as a dead transport, in either
 *    order. Both map to the same retryable `session-lost` fault, and the second one to arrive finds
 *    a renewal already running.
 * 3. **The player is not told.** A fault that starts a renewal is swallowed rather than emitted —
 *    it reaches the inspector as a renewal, not the chip as an error. The player hears about it
 *    exactly once, and only if renewal has genuinely run out of attempts.
 *
 * **What carries across the boundary: the instructions, and nothing else.** They are re-sent
 * byte-identically, which keeps the persona the same and the cached prefix warm. The conversation
 * does not carry — the API's conversation dies with the session and ADR-0042 deleted the ledger
 * that ADR-0012 built to rehydrate from. That is survivable *because* of ADR-0042: Riki answers
 * questions from a snapshot rendered fresh on every turn, so a cold session answers the next
 * question exactly as well as a warm one. What is genuinely lost is the thread — a follow-up
 * ("what about him?") asked across the boundary has nothing to resolve against — and an in-flight
 * turn, which ends in silence. ADR-0045 argues why carrying a transcript tail was not worth it.
 */

import type { RikiConfig } from '@riki/config';
import type { Timers, TurnId } from '@riki/context';
import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';
import { TOOLS, voice } from '@riki/protocol';
import type {
  ApiKey,
  CaptureMode,
  ClientSecretBroker,
  ToolDispatcher,
  TurnEndReason,
  VoiceEvent,
  VoiceFault,
} from '@riki/realtime';
import { createClientSecretBroker, DEFAULT_RENEW_AFTER_MS } from '@riki/realtime';
import type { MonoMs } from '@riki/world-model';

import type { SessionTurn, VoiceSessionPort } from '../agent/index.js';
import type { VoiceWindow, VoiceWindowFactory } from './contracts.js';

/**
 * The session's own view of what happened, for the tray's health line and for tests.
 *
 * `unavailable` is the resting state with no API key: the app boots, everything upstream of speech
 * runs, and the UI says voice is off (ADR-0006). It is not an error.
 */
export type VoiceSessionState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'unavailable';

/**
 * Why a session is being replaced. `age` is the scheduled renewal before the 60-minute cap; `lost`
 * is the reactive one, after the session died — of the cap, or of anything else.
 */
export type RenewalReason = 'age' | 'lost';

export interface VoiceSessionTelemetry {
  /** What Riki was handed for a turn, as a size. The rendered text is never logged (privacy §10). */
  speaking(turnId: TurnId, scenario: boolean, chars: number): void;
  fault(kind: VoiceFault['kind'], message: string): void;
  state(state: VoiceSessionState): void;
  /** Undecodable traffic on the bridge. Should be zero — both sides are one build. */
  bridgeProblem(detail: string): void;
  /**
   * A renewal, at each of its four moments (ADR-0045).
   *
   * Separate from `fault` on purpose, and the distinction is the point of the signal: a renewal is
   * the ordinary end of a session's life and the player is meant never to notice it, so it must not
   * land in the inspector's Problems panel next to things that are genuinely broken. It still has
   * to be *visible*, because the failure this replaces was invisible — a session that expired and a
   * session that was working looked identical from outside until someone pressed the key.
   *
   * `gaveUp` is the one that is also a problem: renewal has run out of attempts and the player has
   * now been told.
   */
  renewal(
    phase: 'started' | 'opened' | 'retrying' | 'gaveUp',
    reason: RenewalReason,
    detail: string,
  ): void;
  /**
   * A tool call that produced no fact, and why.
   *
   * The name is whatever the model said, so it may not be one of the five. `reason` is
   * `packages/realtime`'s `ToolCallRejection` — `unknown-tool`, `malformed-json`,
   * `invalid-arguments`, `no-tools`, `no-call-id` — or `bridge-timeout`, which is the renderer
   * answering on our behalf because this process did not.
   *
   * Separate from `fault` for the same reason `renewal` is: it is not something to show the
   * player. ADR-0049 chose a vaguer sentence over an error nobody can act on, and the whole cost
   * of that choice is that the layer goes wrong quietly. This is the signal that makes it loud
   * enough for whoever is reading the inspector, and there is no other.
   */
  toolRejected(name: string, reason: string): void;
}

export interface VoiceSessionDeps {
  readonly config: RikiConfig;
  readonly windows: VoiceWindowFactory;
  readonly clock: { now(): MonoMs };
  /**
   * A stable, hashed install id. realtime research §6 is explicit that a client-supplied safety
   * identifier is worthless for abuse attribution, and dota2 §7 requires the Steam ID be hashed
   * before any egress — both point at this being computed in main and passed in.
   */
  readonly safetyIdentifier: string;
  /** `globalThis.fetch`. Injected so minting is testable with no network. */
  readonly fetch: Parameters<typeof createClientSecretBroker>[0]['fetch'];
  readonly telemetry?: VoiceSessionTelemetry;
  /**
   * How renewal wakes up (ADR-0045). `systemTimers` in the app, `ManualTimers` in a test.
   *
   * **Optional, and absent is a real mode with a real cost:** with no timers there is no scheduled
   * renewal and no retry backoff, so the session runs until it expires and is then replaced
   * reactively, once. That is the correct behaviour for the tests that predate renewal and for any
   * caller that has no clock to offer — a renewal that reacts is much better than none — but it is
   * not the product path, and `main/index.ts` passes `systemTimers`.
   */
  readonly timers?: Timers;
  /** Overridable so a test does not wait 50 minutes. Defaults to `DEFAULT_RENEW_AFTER_MS`. */
  readonly renewal?: RenewalOptions;
  /**
   * What answers the model's tool calls (ADR-0042, T12).
   *
   * The five tools read a `WorldState`, and this process is the only one that may hold one
   * (ADR-0002, ADR-0015) — so the session in the voice window reaches them through a request on
   * the preload bridge and this is the far end of it. `main/agent/tools.ts` builds the real one
   * over the live world model; the composition root wraps it in `observeToolCalls` so the
   * inspector's trace panel fills (ADR-0047).
   *
   * **Optional, and its absence is a whole mode rather than a missing feature.** With no
   * dispatcher, `voice.session.open` carries `tools: false`, the renderer advertises nothing, and
   * Riki answers from the injected snapshot exactly as it did before ADR-0042 — which is the
   * behaviour every test that predates this ticket expects, and the behaviour ADR-0049 chose over
   * advertising five tools that always answer `unknown`.
   */
  readonly tools?: ToolDispatcher;
}

export interface RenewalOptions {
  readonly renewAfterMs?: number;
  /**
   * Between attempts. Length is the attempt budget: run off the end and renewal gives up, tells the
   * player once, and leaves the chip degraded.
   *
   * Every entry must exceed `MIN_MINT_INTERVAL_MS` — `ClientSecretBroker` refuses more than one
   * mint a second and that refusal is itself a retryable fault, so a faster backoff would spend
   * attempts arguing with our own rate limiter instead of with the network.
   */
  readonly backoffMs?: readonly number[];
  /**
   * How long to wait for the renderer to say `ready` before treating the reopen as failed.
   *
   * A directive sent into a wedged renderer produces no error of any kind, which is the shape of
   * failure this whole area keeps rediscovering. Comfortably past the WebRTC transport's own
   * 10-second connect timeout, so a slow negotiation is not mistaken for a dead one.
   */
  readonly readyTimeoutMs?: number;
}

const DEFAULT_RENEWAL: Required<RenewalOptions> = {
  renewAfterMs: DEFAULT_RENEW_AFTER_MS,
  backoffMs: [2_000, 5_000, 15_000, 30_000],
  readyTimeoutMs: 20_000,
};

export interface VoiceSession extends VoiceSessionPort {
  readonly state: VoiceSessionState;
  /**
   * Open a Realtime session for this match.
   *
   * Per match rather than per app: the instructions are frozen at `match_started` (ADR-0011) and
   * the API's own session cap is 60 minutes. It opens at match start rather than at the first key press because SDP
   * negotiation is 300–500 ms that would otherwise land on the player's first utterance, and an
   * idle session costs nothing — billing is per token and no tokens flow while the gate is shut.
   */
  openMatch(instructions: string): Promise<void>;
  closeMatch(reason: string): Promise<void>;
  /** Overlay §5.5: level frames cross while the chip can show bars, and not otherwise. */
  setLevelsEnabled(enabled: boolean): void;
  dispose(): Promise<void>;
}

/** Sequence numbers, not random ids: a fixture-driven test has to reproduce them. */
let turnCounter = 0;

export function resetVoiceTurnIds(): void {
  turnCounter = 0;
}

function nextTurnId(): TurnId {
  turnCounter += 1;
  return `voice_${String(turnCounter)}` as TurnId;
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  const telemetry = deps.telemetry;
  const listeners = new Set<(event: VoiceEvent) => void>();

  let window: VoiceWindow | null = null;
  let ready = false;
  /** Directives that arrived before `voice.ready`. See the header. */
  let queued: VoiceDirective[] = [];
  let state: VoiceSessionState = 'idle';
  let disposed = false;

  const renewal = { ...DEFAULT_RENEWAL, ...deps.renewal };

  /**
   * The instructions of the open match, and the whole of what carries across a renewal.
   *
   * Non-null means "a match is open, and renewing it is meaningful". `closeMatch` clears it, which
   * is what stops a timer that has already been armed from reopening a match that ended.
   */
  let openInstructions: string | null = null;
  /** A renewal is in flight; a second trigger must join it rather than start another. */
  let renewing = false;
  /** Consecutive failed attempts. Reset by the renderer reaching `ready`, and only by that. */
  let renewAttempt = 0;
  /** Carried across the retries so every line the inspector shows names the original trigger. */
  let renewReason: RenewalReason | null = null;
  /** Cancels whichever renewal deadline is pending — the scheduled one, a backoff, or the wait. */
  let cancelRenewTimer: (() => void) | null = null;

  const apiKey: ApiKey | null = deps.config.openai.apiKey;

  const broker: ClientSecretBroker | null =
    apiKey === null
      ? null
      : createClientSecretBroker({
          // The one place the key is used, and it does not leave this closure. `ApiKey.reveal()`
          // has exactly one call site inside that package too — ADR-0022.
          apiKey,
          safetyIdentifier: deps.safetyIdentifier,
          fetch: deps.fetch,
          now: () => deps.clock.now(),
        });

  function setState(next: VoiceSessionState): void {
    if (state === next) return;
    state = next;
    telemetry?.state(next);
  }

  function emit(event: VoiceEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function raise(kind: VoiceFault['kind'], message: string, retryable: boolean): void {
    telemetry?.fault(kind, message);
    emit({ kind: 'fault', fault: { kind, message, persistent: !retryable, retryable } });
  }

  function send(directive: VoiceDirective): void {
    if (window === null) return;
    if (!ready) {
      queued.push(directive);
      return;
    }
    window.send(directive);
  }

  function onUpdate(update: VoiceUpdate): void {
    switch (update.type) {
      case 'voice.ready': {
        ready = true;
        const pending = queued;
        queued = [];
        for (const directive of pending) window?.send(directive);
        return;
      }

      case 'voice.event': {
        const event = update.event;
        if (event.kind === 'level') {
          // The renderer sends no timestamp — the two processes share no monotonic epoch
          // (schemas/voice.ts). Main stamps it, which is the clock the overlay's ballistics use.
          emit({
            kind: 'level',
            source: event.source,
            value: event.value,
            at: deps.clock.now(),
          });
          return;
        }
        if (event.kind === 'fault') {
          // The expiry, and everything that looks like it. Swallowed rather than emitted: the
          // player is not told about a session that is being replaced under them, and the second
          // signal of the same loss finds a renewal already running and is swallowed too
          // (ADR-0045). It is still visible — as a renewal in the inspector, not as a problem.
          if (isRenewable(event.fault)) {
            void renew('lost', event.fault.message);
            return;
          }
          telemetry?.fault(event.fault.kind, event.fault.message);
        }
        emit(event as VoiceEvent);
        return;
      }

      case 'voice.session.state':
        setState(update.state);
        if (update.state !== 'ready') return;
        // The only evidence a session actually exists, and therefore the only thing that closes a
        // renewal and the only thing that resets the attempt budget. Arming the next deadline from
        // here rather than from the send is deliberate — see `armScheduledRenewal`.
        cancelRenewTimer?.();
        cancelRenewTimer = null;
        if (renewing) {
          renewing = false;
          telemetry?.renewal(
            'opened',
            renewReason ?? 'lost',
            `a new session is open after ${String(renewAttempt + 1)} attempt(s)`,
          );
          renewReason = null;
        }
        renewAttempt = 0;
        armScheduledRenewal();
        return;

      case 'voice.tool.call':
        // Not awaited, and this is the only floating promise on this path. `answerToolCall` never
        // rejects, and holding `onUpdate` open would stall every level frame and turn event queued
        // behind it — on the one message that is allowed to take milliseconds.
        void answerToolCall(update);
        return;

      case 'voice.tool.rejected':
        // The model got the tool surface wrong, or our own bridge did not answer in time. It
        // reaches the inspector as a call that produced no fact, and it never reaches the chip:
        // ADR-0049 chose a vaguer sentence over an error the player can do nothing about. This is
        // the only visibility these failures have — `observeToolCalls` cannot see them, because
        // nothing was dispatched.
        telemetry?.toolRejected(update.name, update.reason);
        return;

      case 'voice.window.applied':
        // `packages/context`'s `applyWindowPlan` is the consumer, and the composition root has not
        // wired the retention loop to a producer yet — nothing in main builds a `WindowPlan`
        // today. Accepted rather than dropped as unknown so that wiring is a one-line change here
        // rather than a protocol change.
        return;
    }
  }

  /**
   * Answer one `voice.tool.call`, and answer it whatever happens.
   *
   * The mirror of `packages/realtime`'s `answerToolCall`, and it obeys the same rule for the same
   * reason: this runs inside a response the player is **already hearing**, so a failure is a
   * `{ unknown: … }` in the shape the model reads for a fact nobody observed (ADR-0043), never a
   * dropped message. A dropped message would leave the renderer's deadline to answer two seconds
   * later, with the sentence held open in between.
   *
   * Three ways it can fail and they all land in the same place:
   *
   * - **No dispatcher.** Unreachable in principle — `voice.session.open` carried `tools: false`, so
   *   the renderer advertised nothing and the model had nothing to call. Answered anyway, because
   *   "unreachable" here rests on a boolean that crossed a process boundary.
   * - **Arguments that no longer parse.** Re-validated against `TOOLS[name]` even though the
   *   renderer already did it, because a bridge is exactly where a shape drifts unnoticed. That is
   *   a genuine bridge fault and is reported as one.
   * - **A tool that threw.** `observeToolCalls` re-throws by design so that the inspector changes
   *   nothing; this is the layer that knows a turn is mid-sentence, and it is where the throw stops.
   */
  async function answerToolCall(
    update: Extract<VoiceUpdate, { type: 'voice.tool.call' }>,
  ): Promise<void> {
    const answer = async (): Promise<Record<string, unknown>> => {
      const dispatcher = deps.tools;
      if (dispatcher === undefined) {
        return { unknown: `Riki has no game state wired up, so \`${update.name}\` cannot answer` };
      }

      const parsed = TOOLS[update.name].arguments.safeParse(update.args);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
        telemetry?.bridgeProblem(
          `tool call \`${update.name}\` had unreadable arguments: ${detail}`,
        );
        return { unknown: `\`${update.name}\` was asked for something it does not understand` };
      }

      try {
        // No cast, and that is worth a line: `parseToolCall` in `packages/realtime` needs one
        // because it narrows to a single tool, and this does not — `name` stays the whole
        // `ToolName` union, `parsed.data` is the matching union of argument types, and the pairing
        // is checked downstream anyway. `encodeToolOutput` parses whatever comes back against
        // `TOOLS[name].result` in the renderer before the model reads a word of it (ADR-0049).
        return await dispatcher.call(update.name, parsed.data);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { unknown: `\`${update.name}\` could not answer: ${message}` };
      }
    };

    send(voice.toolResult(update.callId, await answer()));
  }

  /**
   * Ensure the window exists.
   *
   * Created lazily and kept for the app's lifetime rather than per match: it costs a renderer
   * process to construct and the first one pays a cold Chromium start, which is exactly the
   * 300–500 ms `openMatch` exists to keep off the player's first utterance.
   */
  function ensureWindow(): VoiceWindow | null {
    if (disposed) return null;
    if (window !== null) return window;

    const created = deps.windows.create();
    window = created;
    ready = false;
    created.onUpdate(onUpdate);
    created.onProblem((detail) => {
      telemetry?.bridgeProblem(detail);
    });
    return created;
  }

  /** Why a mint or a send did not produce an open session. `null` means it did. */
  interface OpenFailure {
    readonly kind: VoiceFault['kind'];
    readonly message: string;
    readonly retryable: boolean;
  }

  /**
   * Mint, and send the directive. The half that is identical for a first open and for a renewal.
   *
   * `instructions` is re-sent **byte-identically** on renewal, which is not a detail: it is the
   * cached prefix, and a prefix that differs by a character is a cold cache and a full-price
   * session (realtime §10). It is also why nothing derived from the current match state may be
   * folded in here.
   *
   * Returns the failure rather than reporting it, because the two callers disagree about what a
   * failure means: a first open puts it on the chip, a renewal backs off and tries again.
   */
  async function sendOpen(instructions: string): Promise<OpenFailure | null> {
    if (broker === null) return { kind: 'auth', message: 'no API key', retryable: false };

    const sessionConfig = {
      model: deps.config.realtime.model,
      voice: deps.config.realtime.voice,
      instructions,
      // ADR-0017. VAD stays on so server-side barge-in truncation keeps working, and the gesture
      // — never the model — decides when a response is created.
      turnDetection: {
        kind: 'server_vad' as const,
        createResponse: false as const,
        interruptResponse: true,
        silenceDurationMs: 200,
      },
      noiseReduction: 'near_field' as const,
      transcription: { model: 'gpt-4o-mini-transcribe', language: null },
      truncation: { mode: 'auto' as const, retentionRatio: 0.8 },
    };

    let secret;
    try {
      secret = await broker.mint(sessionConfig);
    } catch (error: unknown) {
      const fault = error as Partial<VoiceFault>;
      return {
        kind: fault.kind ?? 'auth',
        message: error instanceof Error ? error.message : String(error),
        retryable: fault.retryable ?? false,
      };
    }

    send(
      voice.sessionOpen({
        secret: {
          value: secret.value,
          // A *duration*, because the renderer's monotonic epoch is not ours (schemas/voice.ts).
          expiresInMs: Math.max(0, Math.round(secret.expiresAt - deps.clock.now())),
          sessionId: secret.sessionId,
        },
        session: sessionConfig,
        capture: {
          deviceId: deps.config.audio.inputDeviceId,
          // Never false on the product path: without it the model hears itself and self-interrupts
          // in a loop, which is the reason the shell is Electron at all (ADR-0001).
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          preRollMs: deps.config.audio.preRollMs,
        },
        transport: deps.config.realtime.transport,
        budgetUsd: deps.config.realtime.budgetUsd,
        // ADR-0049's coupling, carried across the bridge. The renderer owns the session and
        // therefore the manifest, but the thing that answers a call is on this side — so a session
        // opened by a `createVoiceSession` with no dispatcher advertises nothing and behaves
        // exactly as it did before ADR-0042, which is what makes that a supported configuration
        // rather than a silently degraded one.
        tools: deps.tools !== undefined,
      }),
    );
    return null;
  }

  /**
   * Everything that has to happen before the renderer can be told to open a session, in the order
   * a failure is most likely: no key, then a refused mint.
   */
  async function open(instructions: string): Promise<void> {
    if (broker === null) {
      // Not a fault on the chip. The app boots with voice disabled and says so (ADR-0006), and
      // this is the mode every test and every keyless machine runs in — raising a persistent
      // `auth` fault here would put a permanent error on an overlay that is working as designed.
      setState('unavailable');
      return;
    }

    if (ensureWindow() === null) return;
    // A new match supersedes whatever was open, including a renewal armed against it: nothing
    // below this line should be able to reopen the *previous* match's instructions.
    stopRenewal();
    setState('connecting');

    const failure = await sendOpen(instructions);
    if (failure === null) {
      // Set on the send, not on `ready`: a session the renderer is still negotiating is one that
      // can already die, and it is renewable the moment it can die.
      openInstructions = instructions;
      return;
    }

    setState(failure.retryable ? 'degraded' : 'unavailable');
    raise(failure.kind, failure.message, failure.retryable);
  }

  // ---------------------------------------------------------------------------------------
  // Renewal — ADR-0045. See the header for why it lives in main rather than in @riki/realtime.
  // ---------------------------------------------------------------------------------------

  /** Forget any armed deadline and any renewal in flight. Used by close, dispose and reopen. */
  function stopRenewal(): void {
    cancelRenewTimer?.();
    cancelRenewTimer = null;
    openInstructions = null;
    renewing = false;
    renewAttempt = 0;
    renewReason = null;
  }

  /**
   * The scheduled renewal — the path that is meant to run, and the reason the reactive one is
   * almost never reached.
   *
   * Armed from `ready` rather than from the send, because `ready` is the closest thing we have to
   * the moment the API started counting: the cap runs from session creation, and the mint, the SDP
   * exchange and the DTLS handshake all sit between the directive and that. Arming from the send
   * would put the renewal a few hundred milliseconds *later* than intended, into the margin rather
   * than before it.
   */
  function armScheduledRenewal(): void {
    cancelRenewTimer?.();
    cancelRenewTimer = null;
    const timers = deps.timers;
    if (timers === undefined || openInstructions === null || disposed) return;
    cancelRenewTimer = timers.after(renewal.renewAfterMs, () => {
      cancelRenewTimer = null;
      void renew('age', `${String(Math.round(renewal.renewAfterMs / 60_000))} minutes old`);
    });
  }

  /**
   * Is this fault the end of a session rather than something to show the player?
   *
   * `session-lost` + `retryable` is exactly the set `faultFor` in `@riki/realtime` produces for the
   * 60-minute expiry and for a transport that closed under us, and exactly not the set it produces
   * for a beta-shaped `session.update` (persistent, not retryable — renewing would reopen into the
   * same misconfiguration forever) or for a denied microphone.
   */
  function isRenewable(fault: VoiceFault): boolean {
    return (
      fault.kind === 'session-lost' &&
      fault.retryable &&
      openInstructions !== null &&
      broker !== null &&
      !disposed
    );
  }

  /**
   * Start a renewal, or join the one already running.
   *
   * The join is the whole of property 2 in the header: an expiry arrives as `session_expired` *and*
   * as a dead transport, so this is called twice for one loss and must produce one new session.
   */
  async function renew(reason: RenewalReason, detail: string): Promise<void> {
    if (renewing || openInstructions === null || broker === null || disposed) return;
    renewing = true;
    renewAttempt = 0;
    renewReason = reason;
    telemetry?.renewal('started', reason, detail);
    await attemptRenewal(openInstructions);
  }

  async function attemptRenewal(instructions: string): Promise<void> {
    const reason = renewReason ?? 'lost';
    cancelRenewTimer?.();
    cancelRenewTimer = null;
    if (disposed) return;
    setState('connecting');

    const failure = await sendOpen(instructions);
    if (failure !== null) {
      backOff(instructions, failure.message, failure.retryable);
      return;
    }

    const timers = deps.timers;
    if (timers === undefined) {
      // Nothing to wait with. "Sent" is as far as we can honestly claim to have got, and saying so
      // is better than reporting an `opened` this code has no evidence for.
      renewing = false;
      telemetry?.renewal('opened', reason, 'directive sent; no timers, so `ready` was not awaited');
      return;
    }

    // The directive is out. It is not a renewal until the renderer says `ready`: a directive sent
    // into a wedged voice window produces no error of any kind, and a renewal that silently never
    // completes is indistinguishable from the expiry it was supposed to repair.
    cancelRenewTimer = timers.after(renewal.readyTimeoutMs, () => {
      cancelRenewTimer = null;
      backOff(
        instructions,
        `the voice window did not report ready within ${String(renewal.readyTimeoutMs)} ms`,
        true,
      );
    });
  }

  /** Retry after the next backoff, or run out of attempts and tell the player — once. */
  function backOff(instructions: string, detail: string, retryable: boolean): void {
    const reason = renewReason ?? 'lost';
    const delayMs = renewal.backoffMs[renewAttempt];
    renewAttempt += 1;
    const timers = deps.timers;

    if (!retryable || delayMs === undefined || timers === undefined || disposed) {
      renewing = false;
      renewReason = null;
      telemetry?.renewal('gaveUp', reason, detail);
      setState(retryable ? 'degraded' : 'unavailable');
      // The one place the player is told, and the reason every earlier fault was swallowed: they
      // hear about a lost session when it is actually lost, not once per attempt to get it back.
      raise('session-lost', `Riki could not reopen its voice session: ${detail}`, retryable);
      return;
    }

    telemetry?.renewal(
      'retrying',
      reason,
      `${detail} — attempt ${String(renewAttempt + 1)} in ${String(delayMs)} ms`,
    );
    cancelRenewTimer = timers.after(delayMs, () => {
      cancelRenewTimer = null;
      void attemptRenewal(instructions);
    });
  }

  return {
    get state(): VoiceSessionState {
      return state;
    },

    async openMatch(instructions: string): Promise<void> {
      await open(instructions);
    },

    closeMatch(reason: string): Promise<void> {
      // First: a renewal armed against the match that just ended would reopen a session nobody is
      // in, and — worse — would do it minutes later, with the closed match's instructions.
      stopRenewal();
      // The window stays; only the session inside it closes. Destroying and recreating a renderer
      // between matches would put a cold Chromium start on the first utterance of the next one.
      send(voice.sessionClose(reason));
      setState('idle');
      return Promise.resolve();
    },

    setLevelsEnabled(enabled: boolean): void {
      send(voice.levelEnable(enabled));
    },

    // ---------------------------------------------------------------------------------------
    // CoachingSessionPort
    // ---------------------------------------------------------------------------------------

    speakNow(turn: SessionTurn): Promise<void> {
      telemetry?.speaking(turn.turnId, true, turn.snapshotText.length);
      // The protocol's `eventId` and `salience` are `packages/events`' vocabulary and that package
      // is gone (ADR-0042); the wire fields stay because `packages/protocol` is a coordination
      // event, not this file's to change. They are filled with what is true: the inspector asked.
      send(voice.turnSpeak(turn.turnId, turn.snapshotText, 'scenario.speak', 1));
      // Resolves to "handed over", not to "finished speaking" — see the header.
      return Promise.resolve();
    },

    beginTurn(mode: CaptureMode, now: MonoMs): TurnId {
      void now;
      const turnId = nextTurnId();
      send(voice.turnBegin(turnId, mode));
      return turnId;
    },

    endTurn(turnId: TurnId, reason: TurnEndReason, turn: SessionTurn): Promise<void> {
      if (reason !== 'cancel') telemetry?.speaking(turnId, false, turn.snapshotText.length);
      send(voice.turnEnd(turnId, reason, turn.snapshotText));
      return Promise.resolve();
    },

    abort(): Promise<void> {
      send(voice.command('abort'));
      return Promise.resolve();
    },

    onEvent(listener: (event: VoiceEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await this.closeMatch('app quitting');
      window?.close();
      window = null;
      ready = false;
      queued = [];
      listeners.clear();
      setState('idle');
    },
  };
}
