/**
 * `RealtimeSession` — the stateful facade, and the only object outside this package anyone holds.
 *
 * It owns the turn lifecycle and nothing else: the DSP is `@riki/audio`'s, the wire vocabulary is
 * `protocol/`'s, and what a tool call *means* is `@riki/context`'s. What is genuinely here is the
 * sequencing, and the sequencing is where the documented failures live —
 *
 * - **Barge-in truncation** (`turn/playback.ts`), which corrupts every later turn if skipped.
 * - **Push-to-talk commit**, because with `turn_detection: null` (ADR-0004) nothing else ends a
 *   turn. Forgetting `response.create` produces a session that listens forever and never replies,
 *   which is the "hung session rather than an error" failure the `voice-realtime` skill opens with.
 * - **Retention**, because §5's ceiling arrives 20 minutes into a 45-minute match.
 *
 * The events it emits are named for the interaction machine's `MachineInput`, not for the wire.
 * That is the translation layer earning its keep: when OpenAI renames an event — and §3 documents
 * that they already did once, silently — the diff is confined to `protocol/server-events.ts`.
 */

import { encodeAppendPayload, REALTIME_SAMPLE_RATE } from '@riki/audio';
import {
  appendAudio,
  buildSessionUpdate,
  cancelResponse,
  clearAudio,
  commitAudio,
  createResponse,
  functionCallOutput,
  summaryItem,
} from '../protocol/ga-schema.js';
import { parseServerEvent, type ServerEvent } from '../protocol/server-events.js';
import { CostMeter, type CostSnapshot } from '../cost/meter.js';
import { RetentionPolicy, type RetentionDecision } from '../retention/policy.js';
import { PlaybackTracker } from '../turn/playback.js';
import { ToolCallAccumulator } from '../turn/tool-calls.js';
import { TranscriptAssembler } from '../transcript/assembler.js';
import type { RealtimeTransport } from '../transport/port.js';
import type {
  Millis,
  RealtimeFault,
  SessionConfig,
  Tokens,
  ToolCall,
  TranscriptEntry,
  Unsubscribe,
} from '../types.js';

/** Named for `MachineInput` (apps/desktop/src/main/session/types.ts), so the bridge is a table. */
export type SessionEvent =
  | { readonly kind: 'turn'; readonly event: 'submitted' | 'responseStarted' | 'responseEnded' }
  | { readonly kind: 'tool'; readonly event: 'started'; readonly call: ToolCall }
  | { readonly kind: 'tool'; readonly event: 'ended'; readonly callId: string }
  | { readonly kind: 'transcript'; readonly entry: TranscriptEntry }
  | { readonly kind: 'fault'; readonly fault: RealtimeFault }
  | { readonly kind: 'cost'; readonly snapshot: CostSnapshot }
  | { readonly kind: 'retention'; readonly decision: RetentionDecision };

export interface RealtimeSessionDeps {
  readonly transport: RealtimeTransport;
  readonly config: SessionConfig;
  /** Monotonic. Injected so barge-in timing is deterministic in tests. */
  readonly now: () => Millis;
  readonly retention?: RetentionPolicy;
}

export class RealtimeSession {
  readonly #transport: RealtimeTransport;
  readonly #config: SessionConfig;
  readonly #now: () => Millis;

  readonly #playback: PlaybackTracker;
  readonly #tools = new ToolCallAccumulator();
  readonly #transcript = new TranscriptAssembler();
  readonly #retention: RetentionPolicy;
  readonly #cost: CostMeter;

  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #subscriptions: Unsubscribe[] = [];

  #sessionId: string | null = null;
  #responseActive = false;
  #userAudioMs = 0;
  #assistantAudioMs = 0;
  #pendingInjectedTokens: Tokens = 0;
  /** Item id of the assistant turn in flight, for retention bookkeeping. */
  #currentItemId: string | null = null;

  constructor(deps: RealtimeSessionDeps) {
    this.#transport = deps.transport;
    this.#config = deps.config;
    this.#now = deps.now;
    // `config.retentionRatio` is deliberately *not* forwarded here. It configures the API's own
    // truncation, which is the backstop; this policy is what keeps us from ever reaching it, and
    // it triggers at a different point, so the two ratios are not the same number. See the note
    // on `DEFAULTS` in retention/policy.ts.
    this.#retention = deps.retention ?? new RetentionPolicy();
    this.#cost = new CostMeter(deps.config.model);
    this.#playback = new PlaybackTracker(
      deps.transport.playbackPositionMs === undefined
        ? {}
        : { positionMs: deps.transport.playbackPositionMs },
    );
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get speaking(): boolean {
    return this.#playback.speaking;
  }

  get transcript(): TranscriptAssembler {
    return this.#transcript;
  }

  get cost(): CostSnapshot {
    return this.#cost.snapshot();
  }

  on(fn: (event: SessionEvent) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async connect(): Promise<void> {
    this.#subscriptions.push(
      this.#transport.onEvent((raw) => {
        this.#onRaw(raw);
      }),
    );
    this.#subscriptions.push(
      this.#transport.onFault((fault) => {
        this.#emit({ kind: 'fault', fault });
      }),
    );

    await this.#transport.connect();

    // Configure before anything else is sent. A session that receives audio before its format is
    // set interprets it with the default, which is the beta-schema failure by another route.
    this.#transport.send(buildSessionUpdate(this.#config));
  }

  async close(): Promise<void> {
    while (this.#subscriptions.length > 0) this.#subscriptions.pop()?.();
    await this.#transport.close();
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Capture — implements @riki/audio's `AudioChunkSink`
  // -------------------------------------------------------------------------------------------

  /**
   * On WebRTC the samples ride the media track and this is a no-op for the wire, but the duration
   * accounting still matters: it is what retention and cost are computed from.
   *
   * Structurally satisfies `AudioChunkSink` while ignoring its `at` — duration comes from the
   * sample count, which is exact, rather than from a timestamp, which is not.
   */
  append(frame: Float32Array): void {
    this.#userAudioMs += (frame.length / REALTIME_SAMPLE_RATE) * 1000;
    if (this.#transport.kind === 'websocket') {
      this.#transport.send(appendAudio(encodeAppendPayload(frame)));
    }
  }

  /** Context injected for the coming turn — snapshot, preamble, tool output (dota2 §6.2). */
  noteInjectedTokens(tokens: Tokens): void {
    this.#pendingInjectedTokens += tokens;
  }

  /**
   * Push-to-talk release. With `turn_detection: null` this is the *only* thing that ends a turn:
   * the commit closes the input buffer and `response.create` is what makes the model reply at all.
   */
  commitTurn(): void {
    if (this.#transport.kind === 'websocket') this.#transport.send(commitAudio());
    this.#transport.send(createResponse());
    this.#emit({ kind: 'turn', event: 'submitted' });
  }

  /** The user pressed the key and said nothing — drop the buffer rather than submitting silence. */
  discardTurn(): void {
    this.#transport.send(clearAudio());
    this.#userAudioMs = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Barge-in
  // -------------------------------------------------------------------------------------------

  /**
   * The most important interaction in the whole design (ui-design.md §3.1), and the one with the
   * quietest failure. `at` is when the user's key went down, not when this call happened — the
   * overlay dispatches synchronously and the truncate may be several ticks behind.
   */
  interrupt(at: Millis): void {
    const truncate = this.#playback.truncateFor(at);
    if (truncate !== null) {
      this.#transport.send(truncate);
      const cut = this.#transcript.truncate(truncate.item_id, at);
      if (cut) this.#emit({ kind: 'transcript', entry: cut });
    }
    if (this.#responseActive) this.#transport.send(cancelResponse());

    this.#finishResponse();
    this.#tools.clear();
  }

  abort(): void {
    this.interrupt(this.#now());
    this.discardTurn();
  }

  submitToolResult(callId: string, output: string): void {
    this.#transport.send(functionCallOutput(callId, output));
    this.#emit({ kind: 'tool', event: 'ended', callId });
    // The model needs a nudge to continue: the tool result is an item, not a turn.
    this.#transport.send(createResponse());
  }

  // -------------------------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------------------------

  #onRaw(raw: unknown): void {
    const event = parseServerEvent(raw);
    if (event !== null) this.#onEvent(event);
  }

  #onEvent(event: ServerEvent): void {
    switch (event.kind) {
      case 'session.created':
        this.#sessionId = event.sessionId;
        return;

      case 'response.created':
        this.#responseActive = true;
        this.#emit({ kind: 'turn', event: 'responseStarted' });
        return;

      case 'audio.delta':
        this.#beginPlayback(event.itemId);
        // Only meaningful on the websocket path. On WebRTC the audio rides the media track and
        // these bytes are not what the user is hearing, so counting them would clamp the
        // truncate to a number unrelated to playback.
        if (this.#transport.kind === 'websocket') this.#playback.noteAudioBytes(event.bytes);
        return;

      case 'audio.done':
        this.#playback.noteGeneratedMs(event.durationMs);
        this.#assistantAudioMs += event.durationMs ?? 0;
        return;

      case 'transcript.delta':
        // Starting playback here as well as on `audio.delta` is load-bearing, not belt-and-braces.
        // research §2: on WebRTC "audio never touches the data channel — it rides the media
        // tracks", so `response.output_audio.delta` never arrives on the *default* transport. Key
        // the tracker only off audio deltas and barge-in silently stops truncating on WebRTC,
        // which is the one failure this whole area exists to prevent.
        if (event.role === 'assistant') this.#beginPlayback(event.itemId);
        this.#emit({
          kind: 'transcript',
          entry: this.#transcript.delta(event.itemId, event.role, event.text, this.#now()),
        });
        return;

      case 'transcript.done':
        this.#emit({
          kind: 'transcript',
          entry: this.#transcript.complete(event.itemId, event.role, event.text, this.#now()),
        });
        return;

      case 'tool.delta':
        this.#tools.delta(event.callId, event.name, event.delta);
        return;

      case 'tool.done': {
        const call = this.#tools.done(event.callId, event.argumentsJson);
        if (call !== null) this.#emit({ kind: 'tool', event: 'started', call });
        return;
      }

      case 'response.done':
        if (event.usage !== null) {
          this.#cost.record(event.usage);
          this.#emit({ kind: 'cost', snapshot: this.#cost.snapshot() });
        }
        this.#applyRetention(event.usage?.inputTokens ?? null);
        this.#finishResponse();
        this.#emit({ kind: 'turn', event: 'responseEnded' });
        return;

      case 'error':
        this.#emit({ kind: 'fault', fault: faultFor(event.code, event.message) });
        return;

      case 'session.updated':
      case 'speech.started':
      case 'speech.stopped':
      case 'audio.committed':
      case 'rate-limits':
        return;
    }
  }

  #applyRetention(reportedInputTokens: Tokens | null): void {
    const itemId = this.#currentItemId ?? `turn-${String(this.#retention.retainedTurns)}`;
    const decision = this.#retention.observe({
      itemId,
      userAudioMs: this.#userAudioMs,
      assistantAudioMs: this.#assistantAudioMs,
      injectedTokens: this.#pendingInjectedTokens,
      ...(reportedInputTokens === null ? {} : { reportedInputTokens }),
    });

    this.#userAudioMs = 0;
    this.#assistantAudioMs = 0;
    this.#pendingInjectedTokens = 0;

    if (decision.kind === 'compact') {
      // Replace the dropped span ourselves rather than letting the API truncate oldest-first:
      // §5 is explicit that truncation drops turns outright and does not summarise.
      this.#transport.send(
        summaryItem(
          `[Earlier conversation summarised: ${String(decision.droppedTurns)} turns from this match.]`,
        ),
      );
      this.#transcript.forgetThrough(decision.dropThroughItemId);
    }
    this.#emit({ kind: 'retention', decision });
  }

  #beginPlayback(itemId: string): void {
    if (this.#currentItemId === itemId) return;
    this.#currentItemId = itemId;
    this.#playback.begin(itemId, this.#now());
  }

  #finishResponse(): void {
    this.#responseActive = false;
    this.#playback.end();
    this.#currentItemId = null;
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function faultFor(code: string | null, message: string): RealtimeFault {
  if (code === 'beta-schema') return { kind: 'protocol', message, persistent: true };
  if (code !== null && /auth|api_key|invalid_request_error/i.test(code)) {
    return { kind: 'auth', message, persistent: true };
  }
  if (code !== null && /rate_limit/i.test(code)) {
    return { kind: 'rate-limited', message, persistent: false };
  }
  return { kind: 'server-error', message, persistent: false };
}
