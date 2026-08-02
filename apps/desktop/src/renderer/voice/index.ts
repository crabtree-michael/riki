/**
 * The voice window's entry point: the four DOM adapters, bound to the host.
 *
 * This document is never shown (ADR-0010). It has no styling, no view and no interaction — the
 * chip is the overlay window's job and this window's only visible output is sound. What it has is
 * a microphone, a Web Audio graph, a peer connection and an `<audio>` element, none of which exist
 * outside a Chromium renderer.
 *
 * ## Why this file is nearly empty
 *
 * Everything worth asserting is in `host.ts`, which takes all of the below by injection and can
 * therefore be driven from a Vitest process with no media at all. What is left here is the part
 * that can only be verified by running the app: that `window.rikiVoice` exists, that
 * `new AudioContext()` works, and that the remote track reaches an element that plays it.
 *
 * ## `performance.now()` and not `Date.now()`
 *
 * Same rule as main's clock: every level envelope, gate ramp and silence window subtracts two of
 * these, and a wall clock that steps backwards over an NTP correction makes a sample briefly
 * younger than zero. The epoch is this renderer's own and nothing derived from it crosses the
 * bridge — `schemas/voice.ts` explains why that matters more here than it looks.
 */

import type { MonoMs, RemoteTrack } from '@riki/audio';
import { createDeviceRegistry } from '@riki/audio';

import { VOICE_BRIDGE_KEY } from '../../shared/voice-channels.js';
import type { VoiceBridgePort } from './contracts.js';
import { createVoiceHost } from './host.js';
import { createBrowserMediaDevices } from './media.js';
import { createBrowserPeerConnection } from './peer.js';
import { createWebAudioPorts } from './web-audio.js';

const now = (): MonoMs => performance.now() as MonoMs;

/**
 * Riki's voice, audible.
 *
 * `autoplay` on an element whose `srcObject` is a live `MediaStream` is not gated by Chromium's
 * autoplay policy the way a media file is, and this window has no user gesture to offer anyway.
 * Created once and reused: a new element per response would leak one per turn over a 45-minute
 * match.
 */
function createSpeaker(): (track: RemoteTrack) => void {
  const element = new Audio();
  element.autoplay = true;
  return (track) => {
    element.srcObject = new MediaStream([track as unknown as MediaStreamTrack]);
    // A rejected play is not a reason to lose the session — the fault the player would see is
    // "Riki is silent", which the chip already shows from the turn events.
    void element.play().catch(() => undefined);
  };
}

function bridge(): VoiceBridgePort {
  const api = (globalThis as unknown as Record<string, VoiceBridgePort | undefined>)[
    VOICE_BRIDGE_KEY
  ];
  if (api === undefined) {
    throw new Error(
      `window.${VOICE_BRIDGE_KEY} is missing. The voice window was loaded without its preload ` +
        `script (dist/preload/voice.js) — see main/voice/electron-window.ts.`,
    );
  }
  return api;
}

const audio = createWebAudioPorts(now);
const speaker = createSpeaker();

createVoiceHost({
  bridge: bridge(),
  devices: createDeviceRegistry(createBrowserMediaDevices()),
  media: {
    createBackend: (stream) => audio.createBackend(stream),
    createPeerConnection: createBrowserPeerConnection,
    analyserFor: (track) => audio.analyserFor(track),
    play: speaker,
    dispose: () => audio.dispose(),
  },
  clock: {
    now,
    schedule: (delayMs, fire) => {
      const handle = setTimeout(fire, delayMs);
      return () => {
        clearTimeout(handle);
      };
    },
  },
  fetch: (url, init) => fetch(url, init),
}).start();
