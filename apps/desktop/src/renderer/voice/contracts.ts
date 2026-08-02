/**
 * What the voice host needs from the browser, as ports.
 *
 * Every one of these is a real Web API on the product path — `navigator.mediaDevices`,
 * `AudioContext`, `RTCPeerConnection`, `fetch` — and every one of them is injected. That is not
 * ceremony: it is the difference between `host.test.ts` being a Tier 1 test that runs in a bare
 * Vitest process and a test that needs a microphone, a GPU and a network. `packages/audio` and
 * `packages/realtime` already declare their halves of these structurally (both carry
 * `lib: ["ES2023"]` and cannot name a DOM type); this file is where the DOM-typed implementations
 * are described, and `web-audio.ts`, `media.ts` and `peer.ts` are where they are written.
 */

import type { AudioGraphBackend, MicStream, RemoteAnalyser, RemoteTrack } from '@riki/audio';
import type { PeerConnectionLike } from '@riki/realtime';

/** `window.rikiVoice`, structurally. Mirrors `preload/voice-bridge.ts`'s `VoiceBridgeApi`. */
export interface VoiceBridgePort {
  onDirective(listener: (raw: unknown) => void): () => void;
  send(update: unknown): void;
}

/**
 * The media half, in one object so the host takes one dependency rather than four.
 *
 * `createBackend` receives the very `MicStream` this object's own device registry opened, which is
 * what makes the cast back to a real `MediaStream` inside `web-audio.ts` safe rather than hopeful:
 * the opaque handle and the concrete one never leave the same module pair.
 */
export interface VoiceMediaPorts {
  readonly createBackend: (stream: MicStream) => Promise<AudioGraphBackend>;
  readonly createPeerConnection: () => PeerConnectionLike;
  /** An `AnalyserNode` over the remote track — the only output signal we are allowed to analyse. */
  readonly analyserFor: (track: RemoteTrack) => RemoteAnalyser;
  /**
   * Makes Riki audible.
   *
   * Separate from `analyserFor` because they are different jobs on the same track and only one of
   * them is optional: measuring it drives barge-in, *playing* it is the product. Routing playback
   * through the Web Audio graph instead would work and would put Riki's own voice on a path
   * Chromium's echo canceller reasons about differently — an `<audio>` element with `srcObject` is
   * the arrangement AEC is designed around, and this is not the place to be clever.
   */
  readonly play: (track: RemoteTrack) => void;
  /** Releases anything `createBackend` allocated that the graph does not own (the context). */
  readonly dispose: () => Promise<void>;
}
