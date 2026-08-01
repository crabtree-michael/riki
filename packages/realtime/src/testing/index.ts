/**
 * Shared fakes for @riki/realtime, exported as `@riki/realtime/testing`.
 *
 * These are not test scaffolding: `pnpm dev:replay` drives the whole app through the same
 * fakes, which is what keeps them honest (REPO_SKELETON.md §5.2). No test may require a
 * running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * `FakeRealtimeTransport` is the fake §5.2 specifies: it "replays `fixtures/realtime/*`; records
 * what we sent for assertion; can inject errors and mid-response disconnects". The recording half
 * is what makes the beta/GA schema assertion in §5.4 possible at all — the trap is entirely about
 * what we *send*, and no server response reveals it.
 *
 * **Nothing here opens a socket.** §7.1: anything that costs money is not in the gate, and the
 * pre-commit hook runs with `RIKI_OPENAI_API_KEY` unset.
 */

import type { ClientEvent } from '../protocol/ga-schema.js';
import type { RealtimeTransport, TransportState } from '../transport/port.js';
import type { ApiKey, FetchLike, FetchResponseLike } from '../auth/credentials.js';
import type { Millis, RealtimeFault, TransportKind, Unsubscribe } from '../types.js';

export interface FakeTransportOptions {
  readonly kind?: TransportKind;
  /** Reject the connection, to exercise the offline path without unplugging anything. */
  readonly failConnect?: RealtimeFault;
  /** WebRTC only: what the voice window would report as playback progress. */
  readonly playbackPositionMs?: () => number | null;
}

export class FakeRealtimeTransport implements RealtimeTransport {
  readonly kind: TransportKind;
  readonly playbackPositionMs?: () => number | null;

  /** Everything we sent, in order. The assertion surface for the schema and barge-in tests. */
  readonly sent: ClientEvent[] = [];

  #state: TransportState = 'idle';
  readonly #failConnect: RealtimeFault | undefined;
  readonly #eventListeners = new Set<(raw: unknown) => void>();
  readonly #faultListeners = new Set<(fault: RealtimeFault) => void>();
  readonly #stateListeners = new Set<(state: TransportState) => void>();

  constructor(options: FakeTransportOptions = {}) {
    this.kind = options.kind ?? 'webrtc';
    this.#failConnect = options.failConnect;
    if (options.playbackPositionMs) this.playbackPositionMs = options.playbackPositionMs;
  }

  get state(): TransportState {
    return this.#state;
  }

  connect(): Promise<void> {
    this.#setState('connecting');
    if (this.#failConnect) {
      this.#setState('closed');
      const fault = this.#failConnect;
      // Faults surface through the listener, not as a rejection: a hung session is the failure
      // mode here, and a caller that forgot to catch would produce exactly that.
      for (const listener of this.#faultListeners) listener(fault);
      return Promise.resolve();
    }
    this.#setState('open');
    return Promise.resolve();
  }

  send(event: ClientEvent): void {
    this.sent.push(event);
  }

  close(): Promise<void> {
    this.#setState('closed');
    return Promise.resolve();
  }

  onEvent(fn: (raw: unknown) => void): Unsubscribe {
    this.#eventListeners.add(fn);
    return () => this.#eventListeners.delete(fn);
  }

  onFault(fn: (fault: RealtimeFault) => void): Unsubscribe {
    this.#faultListeners.add(fn);
    return () => this.#faultListeners.delete(fn);
  }

  onStateChange(fn: (state: TransportState) => void): Unsubscribe {
    this.#stateListeners.add(fn);
    return () => this.#stateListeners.delete(fn);
  }

  // --- driving the fake ---

  /** Deliver one server event, as if it had arrived on the wire. */
  emit(raw: unknown): void {
    for (const listener of this.#eventListeners) listener(raw);
  }

  /** Replay a recorded transcript — the `fixtures/realtime/*.jsonl` path. */
  replay(events: readonly unknown[]): void {
    for (const event of events) this.emit(event);
  }

  /** §11.3: recurring "Realtime API not responding" periods are a documented reality. */
  dropMidResponse(): void {
    this.#setState('closed');
    for (const listener of this.#faultListeners) {
      listener({
        kind: 'session-lost',
        message: 'The session ended unexpectedly.',
        persistent: false,
      });
    }
  }

  sentOfType<T extends ClientEvent['type']>(type: T): readonly Extract<ClientEvent, { type: T }>[] {
    return this.sent.filter(
      (event): event is Extract<ClientEvent, { type: T }> => event.type === type,
    );
  }

  #setState(state: TransportState): void {
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}

// ---------------------------------------------------------------------------------------------
// Server-event builders — the wire shapes, so tests do not hand-write JSON with a typo in it
// ---------------------------------------------------------------------------------------------

export const serverEvents = {
  sessionCreated: (id = 'sess_test'): unknown => ({ type: 'session.created', session: { id } }),

  responseCreated: (id = 'resp_1'): unknown => ({ type: 'response.created', response: { id } }),

  /** `bytes` of base64 stands in for audio; the session only uses its length for accounting. */
  audioDelta: (itemId = 'item_1', bytes = 4800): unknown => ({
    type: 'response.output_audio.delta',
    item_id: itemId,
    delta: 'A'.repeat(Math.ceil((bytes * 4) / 3)),
  }),

  audioDone: (itemId = 'item_1', audioEndMs = 2000): unknown => ({
    type: 'response.output_audio.done',
    item_id: itemId,
    audio_end_ms: audioEndMs,
  }),

  assistantTranscriptDelta: (itemId = 'item_1', delta = 'hello'): unknown => ({
    type: 'response.output_audio_transcript.delta',
    item_id: itemId,
    delta,
  }),

  assistantTranscriptDone: (itemId = 'item_1', transcript = 'hello there'): unknown => ({
    type: 'response.output_audio_transcript.done',
    item_id: itemId,
    transcript,
  }),

  userTranscriptDone: (itemId = 'user_1', transcript = 'should I buy a bkb'): unknown => ({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  }),

  toolDelta: (callId = 'call_1', name: string | null = 'get_timings', delta = '{"a"'): unknown => ({
    type: 'response.function_call_arguments.delta',
    call_id: callId,
    ...(name === null ? {} : { name }),
    delta,
  }),

  toolDone: (callId = 'call_1', args = '{"a":1}'): unknown => ({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    arguments: args,
  }),

  responseDone: (
    id = 'resp_1',
    usage: {
      input?: number;
      output?: number;
      cached?: number;
      inputAudio?: number;
      outputAudio?: number;
    } = {},
  ): unknown => ({
    type: 'response.done',
    response: {
      id,
      usage: {
        input_tokens: usage.input ?? 1000,
        output_tokens: usage.output ?? 500,
        input_token_details: {
          cached_tokens: usage.cached ?? 0,
          audio_tokens: usage.inputAudio ?? 600,
        },
        output_token_details: { audio_tokens: usage.outputAudio ?? 400 },
      },
    },
  }),

  error: (code = 'server_error', message = 'Something went wrong'): unknown => ({
    type: 'error',
    error: { code, message },
  }),

  /** The beta name. Receiving one means the session was configured with the beta schema (§3). */
  betaAudioDelta: (): unknown => ({ type: 'response.audio.delta', delta: 'AAAA' }),
};

/** A stub `fetch` for the ephemeral-secret minter. Records requests; never opens a socket. */
export class FakeFetch {
  readonly requests: { url: string; headers: Record<string, string>; body: string }[] = [];

  constructor(
    private readonly response: { ok: boolean; status: number; body: string } = {
      ok: true,
      status: 200,
      body: JSON.stringify({ value: 'ek_test_secret', expires_at: 1_800_000_000 }),
    },
  ) {}

  readonly fetch: FetchLike = (url, init) => {
    this.requests.push({ url, headers: { ...init.headers }, body: init.body });
    const response: FetchResponseLike = {
      ok: this.response.ok,
      status: this.response.status,
      text: () => Promise.resolve(this.response.body),
    };
    return Promise.resolve(response);
  };

  /**
   * Did the real key appear anywhere it should not have? The §5.4 leak assertion.
   *
   * Substring rather than equality, deliberately: the key travels as `Bearer sk-…`, so an
   * equality check would report "no leak" for every request that actually carries one. Pass the
   * headers it is *allowed* to appear in.
   */
  leakedOutside(key: ApiKey, allowedHeaders: readonly string[] = ['Authorization']): boolean {
    const revealed = key.reveal();
    return this.requests.some(
      (request) =>
        request.body.includes(revealed) ||
        Object.entries(request.headers).some(
          ([name, value]) => !allowedHeaders.includes(name) && value.includes(revealed),
        ),
    );
  }
}

/** A monotonic clock a test drives by hand. */
export class FakeClock {
  #now: Millis;

  constructor(start: Millis = 0) {
    this.#now = start;
  }

  readonly now = (): Millis => this.#now;

  advance(ms: Millis): Millis {
    this.#now += ms;
    return this.#now;
  }
}
