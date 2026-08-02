/**
 * The voice window's IPC channel names.
 *
 * Here rather than in `preload/` for the same reason as `channels.ts`: main and preload both have
 * to agree on them, and `shared/` is the one place both can read from without crossing a boundary.
 *
 * The *messages* are `@riki/protocol`'s (`schemas/voice.ts`) and not this file's — a channel name
 * is a string that main and the preload agree on, and `shared/` may not import a package
 * (overlay-architecture.md §11.2). Two channels, one each way, because the bridge is a pipe: what
 * distinguishes a message is its `type`, which the schema owns.
 */

/** The one global the preload bridge adds to the voice renderer's window. */
export const VOICE_BRIDGE_KEY = 'rikiVoice';

export const VOICE_CHANNELS = {
  /** main → renderer: a `VoiceDirective`. */
  directive: 'riki:voice:directive',
  /** renderer → main: a `VoiceUpdate`. */
  update: 'riki:voice:update',
} as const;
