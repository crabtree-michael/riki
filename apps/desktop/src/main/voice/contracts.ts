/**
 * What the main-process half of the voice path needs, as ports.
 *
 * One of these is Electron-shaped (`VoiceWindowFactory`) and the rest are not, which is the whole
 * arrangement: `session.ts` is the composition root's voice half and imports no Electron, so
 * `session.test.ts` drives a full push-to-talk turn and a full coaching turn against a fake window
 * with no browser, no microphone and no network.
 */

import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';

/**
 * The hidden renderer, as main sees it.
 *
 * Deliberately a pipe and not an API: what distinguishes one message from another is its `type`,
 * which `@riki/protocol` owns. A `VoiceWindow` with a method per directive would be the schema
 * written twice.
 */
export interface VoiceWindow {
  send(directive: VoiceDirective): void;
  onUpdate(listener: (update: VoiceUpdate) => void): () => void;
  /**
   * Undecodable traffic from the renderer. Separate from `onUpdate` because it is a *fault* in the
   * bridge rather than a message across it, and folding the two would mean the composition root
   * had to distinguish them anyway.
   */
  onProblem(listener: (detail: string) => void): () => void;
  close(): void;
}

export interface VoiceWindowFactory {
  /** Creates the window and loads its document. Never shown (ADR-0010). */
  create(): VoiceWindow;
}
