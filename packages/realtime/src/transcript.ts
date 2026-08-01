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
 * See docs/design/voice-input-architecture.md §6.1.
 */

import type { ItemId, MonoMs, TurnId, Unsubscribe } from './types.js';

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

/**
 * The write side, held by the session and by nothing else.
 *
 * Split from `TranscriptStream` so that consumers — the ledger, the command parser, captions —
 * get a type with no way to inject a transcript. They observe; only the wire writes.
 */
export interface TranscriptStreamController extends TranscriptStream {
  /** A partial from `response.output_audio_transcript.delta`. Emits a non-final chunk. */
  appendAgent(turnId: TurnId, itemId: ItemId, delta: string, at: MonoMs): void;
  /** `response.output_audio_transcript.done` — authoritative, and replaces the accumulation. */
  completeAgent(turnId: TurnId, itemId: ItemId, transcript: string, at: MonoMs): void;
  /**
   * `conversation.item.input_audio_transcription.completed`. There are no player deltas: the ASR
   * pass runs over the whole utterance, so the first thing we ever hear about it is the result.
   */
  completePlayer(turnId: TurnId, itemId: ItemId, transcript: string, at: MonoMs): void;
  /**
   * Barge-in: finalise what was actually transcribed before the cut, and nothing after.
   *
   * Returns the text so the caller can hand it to the ledger without re-deriving it. Null when
   * the item was already final or was never opened, both of which are ordinary.
   */
  cut(itemId: ItemId, at: MonoMs): string | null;
}

interface OpenItem {
  readonly turnId: TurnId;
  readonly chunks: string[];
  text: string;
  final: boolean;
}

export function createTranscriptStream(): TranscriptStreamController {
  const items = new Map<ItemId, OpenItem>();
  const listeners = new Set<(chunk: TranscriptChunk) => void>();

  const emit = (chunk: TranscriptChunk): void => {
    for (const listener of listeners) listener(chunk);
  };

  const open = (turnId: TurnId, itemId: ItemId): OpenItem => {
    const existing = items.get(itemId);
    if (existing) return existing;
    const created: OpenItem = { turnId, chunks: [], text: '', final: false };
    items.set(itemId, created);
    return created;
  };

  return {
    appendAgent(turnId, itemId, delta, at) {
      const item = open(turnId, itemId);
      if (item.final || delta === '') return;
      item.chunks.push(delta);
      item.text = item.chunks.join('');
      emit({ role: 'agent', turnId, text: item.text, final: false, at });
    },

    completeAgent(turnId, itemId, transcript, at) {
      const item = open(turnId, itemId);
      if (item.final) return;
      // The completion is authoritative: deltas can be dropped by a lossy transport, and the
      // done event carries the whole string. Fall back to the accumulation only if it is empty.
      item.text = transcript !== '' ? transcript : item.chunks.join('');
      item.final = true;
      emit({ role: 'agent', turnId, text: item.text, final: true, at });
    },

    completePlayer(turnId, itemId, transcript, at) {
      const item = open(turnId, itemId);
      if (item.final) return;
      item.text = transcript;
      item.final = true;
      emit({ role: 'player', turnId, text: transcript, final: true, at });
    },

    cut(itemId, at) {
      const item = items.get(itemId);
      if (!item || item.final) return null;
      item.final = true;
      emit({ role: 'agent', turnId: item.turnId, text: item.text, final: true, at });
      return item.text;
    },

    onChunk(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    reset() {
      items.clear();
    },
  };
}
