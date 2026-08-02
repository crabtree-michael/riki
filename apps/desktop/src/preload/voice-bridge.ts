/**
 * The voice window's bridge. Two functions wide, and neither of them can carry a credential in the
 * wrong direction.
 *
 * The overlay's bridge next door has three functions and a validating parse on the way in
 * (`overlay-bridge.ts`); this one is deliberately thinner. It moves opaque values, and
 * `@riki/protocol`'s `decodeVoiceDirective` does the parse **on the renderer side**, where the
 * failure can be reported as a `VoiceFault` the chip can show. Parsing here would put zod in the
 * preload, which under `sandbox: true` is a module the preload cannot resolve at all.
 *
 * What crosses is `@riki/protocol`'s `VoiceDirective` and `VoiceUpdate`. Neither has a field that
 * could hold the API key, and `voice-contract.test.ts` asserts that as a property of the shape
 * rather than as a rule — REPO_SKELETON.md §5.4 and ADR-0015.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { VOICE_BRIDGE_KEY, VOICE_CHANNELS } from '../shared/voice-channels.js';

/**
 * What the voice renderer sees on `window.rikiVoice`.
 *
 * Structural and free of `@riki/protocol` types on purpose: `contextBridge` structured-clones
 * everything across, so the renderer re-validates what it receives rather than trusting a type
 * that only existed on this side.
 */
export interface VoiceBridgeApi {
  /** Every directive main sends, unparsed. Returns its own disposer. */
  onDirective(listener: (raw: unknown) => void): () => void;
  /** One `VoiceUpdate`, already built by `@riki/protocol`'s constructors. */
  send(update: unknown): void;
}

export function exposeVoiceBridge(): void {
  const api: VoiceBridgeApi = {
    onDirective(listener) {
      const handler = (_event: IpcRendererEvent, raw: unknown): void => {
        listener(raw);
      };
      ipcRenderer.on(VOICE_CHANNELS.directive, handler);
      return () => {
        ipcRenderer.off(VOICE_CHANNELS.directive, handler);
      };
    },

    send(update) {
      ipcRenderer.send(VOICE_CHANNELS.update, update);
    },
  };

  contextBridge.exposeInMainWorld(VOICE_BRIDGE_KEY, api);
}
