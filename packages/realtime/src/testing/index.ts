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
 *
 * Contracts only.
 */

import type { Unsubscribe, VoiceFault } from '../types.js';
import type { RealtimeTransport } from '../transport.js';
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

  onSend(listener: (event: ClientEvent) => void): Unsubscribe;
}

export declare function createFakeRealtimeTransport(): FakeRealtimeTransport;

/**
 * The corpus `fixtures/realtime/` needs, named here so an implementer adds them rather than
 * discovering later which ones are missing: a happy push-to-talk turn, a barge-in, a tool call
 * with a consent gate, a mid-response disconnect, a context-exhaustion sequence, and a 25-minute
 * session for the retention test.
 */
export declare const REQUIRED_FIXTURES: readonly string[];
