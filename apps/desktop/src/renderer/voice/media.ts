/**
 * `navigator.mediaDevices`, as `@riki/audio`'s `MediaDevicesLike`.
 *
 * `packages/audio` carries `lib: ["ES2023"]` and cannot name a DOM type, so `MicStream` is an
 * opaque `{ id: string }` over there and a real `MediaStream` here. The two never meet outside
 * this module and `web-audio.ts`, which is what makes the cast in `asStream` safe rather than
 * hopeful: nothing else in the app constructs a `MicStream`.
 *
 * See docs/design/voice-input-architecture.md §3.1, §3.5.
 */

import type {
  AudioDeviceInfo,
  CaptureRequest,
  DeviceId,
  MediaDevicesLike,
  MicPermission,
  MicStream,
} from '@riki/audio';

/** The one direction that is a real cast. Everything else is a widening. */
export function asMediaStream(stream: MicStream): MediaStream {
  return stream as unknown as MediaStream;
}

function toConstraints(request: CaptureRequest): MediaStreamConstraints {
  return {
    audio: {
      ...(request.deviceId === null ? {} : { deviceId: { exact: request.deviceId } }),
      // Never false on the product path. Without it the model hears itself and self-interrupts in
      // a loop (realtime research §11.5) — the failure ADR-0001 chose Electron over Tauri to avoid.
      echoCancellation: request.echoCancellation,
      noiseSuppression: request.noiseSuppression,
      autoGainControl: request.autoGainControl,
    },
    video: false,
  };
}

export function createBrowserMediaDevices(): MediaDevicesLike {
  const changeListeners = new Set<() => void>();
  const onChange = (): void => {
    for (const listener of [...changeListeners]) listener();
  };

  return {
    async enumerate(): Promise<readonly AudioDeviceInfo[]> {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')
        .map((device) => ({
          id: device.deviceId as DeviceId,
          // Empty until permission is granted — a browser rule, not a bug. The chip shows
          // "System default" rather than an empty row (ui-design §9.2).
          label: device.label === '' ? 'Unnamed device' : device.label,
          kind: device.kind === 'audioinput' ? ('input' as const) : ('output' as const),
          isDefault: device.deviceId === 'default' || device.deviceId === '',
        }));
    },

    async getUserMedia(request: CaptureRequest): Promise<MicStream> {
      // Rejects with a `DOMException` whose `name` is what `packages/audio` keys its fault off —
      // `NotAllowedError` is `mic-denied`, everything else is `no-input-device`.
      const stream = await navigator.mediaDevices.getUserMedia(toConstraints(request));
      return stream;
    },

    stop(stream: MicStream): void {
      for (const track of asMediaStream(stream).getTracks()) track.stop();
    },

    onDeviceChange(listener: () => void): () => void {
      if (changeListeners.size === 0) {
        navigator.mediaDevices.addEventListener('devicechange', onChange);
      }
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
        if (changeListeners.size === 0) {
          navigator.mediaDevices.removeEventListener('devicechange', onChange);
        }
      };
    },

    async permission(): Promise<MicPermission> {
      try {
        // Not in every browser's `PermissionName` union, and Chromium supports it — which is the
        // only engine this ships on (ADR-0001).
        const status = await navigator.permissions.query({
          name: 'microphone',
        });
        return status.state === 'granted'
          ? 'granted'
          : status.state === 'denied'
            ? 'denied'
            : 'prompt';
      } catch {
        // A browser that refuses the query has not denied anything. "Ask" is the honest answer,
        // and it is what the first run does anyway.
        return 'prompt';
      }
    },
  };
}
