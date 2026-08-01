/**
 * @riki/realtime
 *
 * Owns the OpenAI Realtime session: transport, event bus, barge-in with
 * conversation.item.truncate, context retention policy, and cost accounting.
 *
 * The only package permitted to import the `openai` SDK (§6.2). It receives the API key
 * injected from @riki/config and never reads the environment itself (§7.1).
 *
 * Four things to know before changing anything here — each is a documented failure that produces
 * no error at all:
 *
 * 1. **The GA schema is not the beta schema.** `protocol/ga-schema.ts` is the only file that may
 *    build a `session.update`, and its test asserts the payload exactly. A top-level `voice` or a
 *    string `input_audio_format` silently misconfigures the session (research §3).
 * 2. **Barge-in must send `conversation.item.truncate`.** Push-to-talk means `turn_detection:
 *    null`, which means no server VAD, which means the server *cannot* truncate for us even on
 *    WebRTC. See `turn/playback.ts` and ADR-0017.
 * 3. **Context fills in 15–20 minutes; a match is 45.** `retention/policy.ts` compacts rarely and
 *    deeply, because every compaction busts an 80× prompt-cache discount.
 * 4. **Nothing here reads a global.** The clock, the transport and the credentials are injected,
 *    which is what keeps the whole package testable with no socket and no key (§5.2, §7.1).
 *
 * The class decomposition is recorded in ADR-0017.
 */

export * from './types.js';

export * from './protocol/constants.js';
export * from './protocol/ga-schema.js';
export * from './protocol/server-events.js';

export * from './transport/port.js';

export * from './turn/playback.js';
export * from './turn/tool-calls.js';
export * from './transcript/assembler.js';

export * from './retention/policy.js';
export * from './cost/meter.js';
export * from './auth/credentials.js';

export * from './session/session.js';
