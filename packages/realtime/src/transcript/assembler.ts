/**
 * Transcript assembly, for captions and for the conversation ledger.
 *
 * Two consumers with opposite needs, which is why entries carry `final`:
 *
 * - **Captions** (ui-design.md §5.4) want partials as they arrive, so text appears while Riki is
 *   still speaking. They are off by default and must never auto-enable (§9.3) — a transcript
 *   overlay on a live stream is a privacy incident waiting to happen.
 * - **The conversation ledger** (ADR-0012, `packages/context/src/memory`) wants finals only. A
 *   ledger of partials would store every prefix of every sentence.
 *
 * One warning carried over from openai-realtime-research.md §11.6: **the transcript is not a
 * recording of the audio.** The model sometimes speaks text that differs from what it reports,
 * and function-call arguments have been observed leaking into spoken output. Anything that
 * matters — what the user consented to, what a tool was actually asked — must come from the
 * structured event, never from this text.
 */

import type { Millis, TranscriptEntry, TranscriptRole } from '../types.js';

interface OpenEntry {
  readonly role: TranscriptRole;
  chunks: string[];
  final: boolean;
  text: string;
}

export class TranscriptAssembler {
  readonly #entries = new Map<string, OpenEntry>();
  /** Insertion order, so `history()` reads as a conversation rather than as a hash map. */
  readonly #order: string[] = [];

  delta(itemId: string, role: TranscriptRole, chunk: string, at: Millis): TranscriptEntry {
    const entry = this.#ensure(itemId, role);
    if (chunk !== '') entry.chunks.push(chunk);
    entry.text = entry.chunks.join('');
    return { itemId, role, text: entry.text, final: false, at };
  }

  /**
   * The completed event carries the whole transcript, which is authoritative: deltas can be
   * dropped by a lossy transport, and a user transcript arrives *only* as a completion — there
   * are no deltas for it on some model versions.
   */
  complete(itemId: string, role: TranscriptRole, text: string, at: Millis): TranscriptEntry {
    const entry = this.#ensure(itemId, role);
    entry.text = text !== '' ? text : entry.chunks.join('');
    entry.final = true;
    return { itemId, role, text: entry.text, final: true, at };
  }

  /** Barge-in: what the user heard is what was transcribed up to the cut. */
  truncate(itemId: string, at: Millis): TranscriptEntry | null {
    const entry = this.#entries.get(itemId);
    if (!entry || entry.final) return null;
    entry.final = true;
    return { itemId, role: entry.role, text: entry.text, final: true, at };
  }

  /** Finals only — this is the ledger's view. */
  history(): readonly TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    for (const itemId of this.#order) {
      const entry = this.#entries.get(itemId);
      if (entry?.final === true && entry.text !== '') {
        out.push({ itemId, role: entry.role, text: entry.text, final: true, at: 0 });
      }
    }
    return out;
  }

  /**
   * Drop everything up to and including `itemId`. Called when the retention policy compacts, so
   * the assembler does not accumulate a whole match's transcript in memory alongside the ledger
   * that already owns it.
   */
  forgetThrough(itemId: string): void {
    const cut = this.#order.indexOf(itemId);
    if (cut < 0) return;
    for (const dropped of this.#order.splice(0, cut + 1)) this.#entries.delete(dropped);
  }

  clear(): void {
    this.#entries.clear();
    this.#order.length = 0;
  }

  #ensure(itemId: string, role: TranscriptRole): OpenEntry {
    const existing = this.#entries.get(itemId);
    if (existing) return existing;
    const entry: OpenEntry = { role, chunks: [], final: false, text: '' };
    this.#entries.set(itemId, entry);
    this.#order.push(itemId);
    return entry;
  }
}
