/**
 * The Web Audio graph, as `@riki/audio`'s `AudioGraphBackend`.
 *
 * The shape and the three decisions in it are `capture.ts`'s and are documented there; this file
 * is only the nodes:
 *
 *   MediaStreamSource ─► Analyser ────────────────────────────► levels, silence
 *          │
 *          ▼
 *     Delay(preRollMs) ─► Gain(gate) ─► MediaStreamDestination ─► the outbound track
 *
 * Three things here are easy to get wrong and silent when you do.
 *
 * **The `AudioContext` runs at the device rate, not 24 kHz.** Under WebRTC that is correct and
 * intended: Chromium encodes Opus from whatever the graph produces and the API decodes it on the
 * far side, so `packages/audio`'s resampler does not run on this path at all (voice-realtime skill,
 * 2026-08-01). Forcing `sampleRate: 24000` here would resample twice for no reason.
 *
 * **`setValueAtTime` before `linearRampToValueAtTime`, every time.** Without the anchor the ramp
 * starts from whatever the last scheduled event was, which after a rapid press-release is the
 * *previous* ramp's target — so the gate opens instantly, and a click at the start of an utterance
 * is something the server's VAD occasionally reads as speech.
 *
 * **The analyser is upstream of the gate and the delay.** Level and silence have to be true while
 * the gate is shut, or the overlay's silence nudge and 8 s listen timeout have nothing to run on
 * (ADR-0016).
 */

import type {
  AudioGraphBackend,
  MicStream,
  MonoMs,
  RemoteAnalyser,
  RemoteTrack,
  Unsubscribe,
} from '@riki/audio';

import { asMediaStream } from './media.js';

/** ~30 Hz, matching `DEFAULT_CAPTURE_OPTIONS.levelIntervalMs` and the chip's bar rate. */
const FRAME_INTERVAL_MS = 33;

/** 1024 samples is ~21 ms at 48 kHz — short enough for a responsive bar, long enough for a stable RMS. */
const FFT_SIZE = 1024;

export interface WebAudioPorts {
  createBackend(stream: MicStream): Promise<AudioGraphBackend>;
  analyserFor(track: RemoteTrack): RemoteAnalyser;
  dispose(): Promise<void>;
}

/**
 * Frames from an `AnalyserNode`, on an interval rather than on `requestAnimationFrame`.
 *
 * rAF is throttled to zero in a window that is never shown — which this one never is (ADR-0010) —
 * so a level meter built on it would report nothing at all in production while working perfectly
 * in any test that opens a visible window.
 */
function pump(analyser: AnalyserNode, now: () => MonoMs): RemoteAnalyser {
  const listeners = new Set<(frame: Float32Array, at: MonoMs) => void>();
  const buffer = new Float32Array(analyser.fftSize);

  const handle = setInterval(() => {
    if (listeners.size === 0) return;
    analyser.getFloatTimeDomainData(buffer);
    const at = now();
    for (const listener of [...listeners]) listener(buffer, at);
  }, FRAME_INTERVAL_MS);

  return {
    onFrame(listener): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      clearInterval(handle);
      listeners.clear();
      analyser.disconnect();
    },
  };
}

export function createWebAudioPorts(now: () => MonoMs): WebAudioPorts {
  let context: AudioContext | null = null;

  const contextFor = (): AudioContext => {
    context ??= new AudioContext();
    return context;
  };

  return {
    createBackend(stream: MicStream): Promise<AudioGraphBackend> {
      const ctx = contextFor();

      let source = ctx.createMediaStreamSource(asMediaStream(stream));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      const delay = ctx.createDelay(2);
      const gate = ctx.createGain();
      const destination = ctx.createMediaStreamDestination();

      gate.gain.value = 0;
      source.connect(analyser);
      source.connect(delay);
      delay.connect(gate);
      gate.connect(destination);

      const track = destination.stream.getAudioTracks()[0];
      if (track === undefined) {
        return Promise.reject(new Error('MediaStreamDestination produced no audio track.'));
      }

      const frames = pump(analyser, now);

      const backend: AudioGraphBackend = {
        outbound: track,

        setGate(value, rampMs) {
          const at = ctx.currentTime;
          // The anchor. Without it the ramp starts from the last *scheduled* value rather than
          // the current one, and a rapid press-release makes the gate step instead of ramp.
          gate.gain.cancelScheduledValues(at);
          gate.gain.setValueAtTime(gate.gain.value, at);
          if (rampMs <= 0) gate.gain.setValueAtTime(value, at);
          else gate.gain.linearRampToValueAtTime(value, at + rampMs / 1000);
        },

        onAnalyserFrame(listener) {
          return frames.onFrame(listener);
        },

        replaceSource(next: MicStream): Promise<void> {
          // §3.5: swapping the microphone must not touch the gate, the delay or the track, so
          // unplugging a headset mid-match does not renegotiate SDP or interrupt a turn.
          source.disconnect();
          source = ctx.createMediaStreamSource(asMediaStream(next));
          source.connect(analyser);
          source.connect(delay);
          return Promise.resolve();
        },

        setPreRoll(delayMs) {
          delay.delayTime.value = Math.max(0, delayMs) / 1000;
        },

        async dispose(): Promise<void> {
          frames.dispose();
          source.disconnect();
          delay.disconnect();
          gate.disconnect();
          for (const each of destination.stream.getTracks()) each.stop();
          await Promise.resolve();
        },
      };

      return Promise.resolve(backend);
    },

    analyserFor(track: RemoteTrack): RemoteAnalyser {
      const ctx = contextFor();
      // A `MediaStream` wrapping the one remote track. Riki's own voice coming back is the only
      // output signal `packages/audio` is allowed to analyse — there is no capture path for game
      // audio anywhere in this product (dota2 §7).
      const stream = new MediaStream([track as unknown as MediaStreamTrack]);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      source.connect(analyser);

      // Deliberately **not** connected to `ctx.destination`. The remote track is played by the
      // `<audio>` element in `index.ts`; routing it through the graph as well would play it twice.
      return pump(analyser, now);
    },

    async dispose(): Promise<void> {
      const ctx = context;
      context = null;
      if (ctx !== null) await ctx.close();
    },
  };
}
