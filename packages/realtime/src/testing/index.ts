/**
 * Shared fakes for @riki/realtime, exported as `@riki/realtime/testing`.
 *
 * These are not test scaffolding: `pnpm dev:replay` drives the whole app through the same
 * fakes, which is what keeps them honest (REPO_SKELETON.md §5.2). No test may require a
 * running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * `sent()` is the half that is easy to under-build and does most of the work. Every high-risk
 * failure this component has is a failure of what we *sent*: a beta-shaped `session.update`, a
 * missing `conversation.item.truncate`, a `response.create` that raced the tail of the utterance,
 * a delete issued before its replacement summary. None of them is observable in a reply, so the
 * recording is the assertion (docs/design/voice-input-architecture.md §11).
 */

import type { MonoMs, Unsubscribe, VoiceFault } from '../types.js';
import type { RealtimeTransport, TransportState } from '../transport.js';
import type { ClientEvent, ServerEvent } from '../wire.js';

export interface FixtureSession {
  readonly name: string;
  readonly events: readonly ServerEvent[];
}

export interface FakeRealtimeTransport extends RealtimeTransport {
  readonly kind: 'fake';

  /** Replay a recorded session from `fixtures/realtime/`, at recorded or accelerated timing. */
  play(fixture: FixtureSession, speed?: number): Promise<void>;
  /** Emit one server event now, for the cases a recording cannot express. */
  emit(event: ServerEvent): void;

  /** Everything we sent, in order. The subject of most of this package's assertions. */
  sent(): readonly ClientEvent[];

  /** The failure paths that have to be exercised and cannot be recorded from a live session. */
  injectFault(fault: VoiceFault): void;
  dropConnection(during: 'response' | 'idle'): void;
  expireCredential(): void;
  /**
   * The 60-minute cap, exactly as it arrived on 2026-08-09 at 15:43:36: the error first, then the
   * transport gone.
   *
   * Both halves, because both happen and either one alone is a session nobody notices has ended —
   * the error can be lost with the channel that would have carried it, and a channel that closes
   * quietly says nothing about why. `order` exists so a test can assert the two coalesce into one
   * renewal whichever way round they land.
   */
  expireSession(order?: 'error-first' | 'close-first'): void;

  onSend(listener: (event: ClientEvent) => void): Unsubscribe;
}

export function createFakeRealtimeTransport(): FakeRealtimeTransport {
  const sent: ClientEvent[] = [];
  const eventListeners = new Set<(event: ServerEvent) => void>();
  const stateListeners = new Set<(state: TransportState) => void>();
  const sendListeners = new Set<(event: ClientEvent) => void>();

  let credentialValid = true;

  const setState = (state: TransportState): void => {
    for (const listener of stateListeners) listener(state);
  };

  const emit = (event: ServerEvent): void => {
    for (const listener of eventListeners) listener(event);
  };

  return {
    kind: 'fake',

    connect(secret) {
      setState('connecting');
      if (!credentialValid || secret.value === '') {
        setState('closed');
        return Promise.reject(
          Object.assign(new Error('The client secret has expired.'), {
            kind: 'auth',
            persistent: true,
            retryable: false,
          }),
        );
      }
      setState('open');
      emit({ type: 'session.created' });
      return Promise.resolve();
    },

    send(event) {
      sent.push(event);
      for (const listener of sendListeners) listener(event);
    },

    close() {
      setState('closed');
      return Promise.resolve();
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    // --- driving the fake ---

    play(fixture) {
      // Synchronously, and deliberately: a fixture that encoded wall-clock timing would make
      // every test that reads it slow and flaky, and the ordering is what these tests assert.
      for (const event of fixture.events) emit(event);
      return Promise.resolve();
    },

    emit,

    sent() {
      return sent;
    },

    injectFault(fault: VoiceFault) {
      emit({ type: 'error', code: fault.kind, message: fault.message });
    },

    dropConnection(during) {
      // research §11.3 documents recurring "Realtime API not responding" periods. Mid-response is
      // the one that matters: it leaves a turn with no ending, which is the hung-session shape.
      if (during === 'response')
        emit({ type: 'error', code: 'session_lost', message: 'Connection lost mid-response.' });
      setState('closed');
    },

    expireCredential() {
      credentialValid = false;
    },

    expireSession(order = 'error-first') {
      // The API's own words, kept verbatim: a test that asserts on a paraphrase asserts on nothing.
      const error = (): void => {
        emit({
          type: 'error',
          code: 'session_expired',
          message: 'Your session hit the maximum duration of 60 minutes.',
        });
      };
      if (order === 'error-first') error();
      setState('closed');
      if (order === 'close-first') error();
    },

    onSend(listener) {
      sendListeners.add(listener);
      return () => sendListeners.delete(listener);
    },
  };
}

/**
 * The corpus named in the contract, as constants so a test refers to a fixture by name rather
 * than by a string literal that can drift from the filename.
 */
export const REQUIRED_FIXTURES: readonly string[] = [
  'ptt-turn.jsonl',
  'barge-in.jsonl',
  'stray-function-call.jsonl',
  'mid-response-disconnect.jsonl',
  'context-exhaustion.jsonl',
  'long-session-25min.jsonl',
];

/** A monotonic clock a test drives by hand. Nothing in this package reads a real one. */
export class FakeClock {
  #now: MonoMs;

  constructor(start = 0) {
    this.#now = start as MonoMs;
  }

  readonly now = (): MonoMs => this.#now;

  advance(ms: number): MonoMs {
    this.#now = (this.#now + ms) as MonoMs;
    return this.#now;
  }
}
