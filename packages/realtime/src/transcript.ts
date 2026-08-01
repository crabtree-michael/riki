/**
 * Transcripts — where they come from, and what they are not.
 *
 * Speech-to-speech means there is no transcript unless we ask for one: input transcription is a
 * separate ASR pass, configured in session-config.ts and delivered as its own server event. It has
 * three consumers, and the screen is not one of them by default — the ledger
 * (`packages/context` §6.2), the local command parser, and captions, which stay off (ui-design
 * §9.3). Enabling transcription and displaying it are different decisions.
 *
 * Two caveats that are otherwise discovered as bugs. The transcript is produced by a *different
 * model* from the one that heard the audio, so it approximates what was heard rather than
 * recording it — never reconstruct model state from it. And it costs a small per-minute charge on
 * top of the audio tokens, which is why it is a setting rather than a constant.
 *
 * See docs/design/voice-input-architecture.md §6.1. Declarations only.
 */

import type { MonoMs, TurnId, Unsubscribe } from './types.js';

export interface TranscriptChunk {
  readonly role: 'player' | 'agent';
  readonly turnId: TurnId;
  readonly text: string;
  /** Partial chunks exist for captions; only a final one reaches the ledger or the parser. */
  readonly final: boolean;
  readonly at: MonoMs;
}

export interface TranscriptStream {
  onChunk(listener: (chunk: TranscriptChunk) => void): Unsubscribe;
  /** Cleared at session close and never persisted here — persistence is the ledger's decision. */
  reset(): void;
}
