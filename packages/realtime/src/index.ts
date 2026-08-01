/**
 * @riki/realtime
 *
 * Owns the OpenAI Realtime session: credentials, transport, event bus, barge-in with
 * conversation.item.truncate, the context-window mechanism, and cost accounting.
 *
 * The only package permitted to import the `openai` SDK (REPO_SKELETON.md §6.2). It receives the
 * API key injected from @riki/config and never reads the environment itself (§7.1) — and under
 * ADR-0015 only the main-process half ever sees it, the renderer getting an ephemeral secret.
 *
 * The retention *policy* is `packages/context`'s (ADR-0012); what is here is the wire.
 *
 * Fully implemented. Every browser primitive the package needs — the peer connection, the socket,
 * `fetch` — arrives through a structural port, so the whole thing including SDP negotiation is a
 * Tier 1 test with no network and no browser. §15 of the design document maps each section to a
 * file here.
 *
 * Four things to know before changing anything here, each a documented failure that produces no
 * error at all:
 *
 * 1. **The GA schema is not the beta schema.** `session-config.ts` is the only producer of a wire
 *    payload, and `assertGaShape` runs on the way out.
 * 2. **VAD stays on** (ADR-0017) so server-side barge-in truncation keeps working; the gesture,
 *    not the model, decides when a response is created.
 * 3. **The key is an `ApiKey`, not a string** (ADR-0022), so it cannot reach a log by accident.
 * 4. **A cancel needs a truncate even though a barge-in does not** (§5.5). The server truncates
 *    when *it* sees the player speak; an `Esc` has no speech behind it, so nothing fires and the
 *    model believes it finished a sentence the player cut off.
 */

export type * from './types.js';

export * from './credentials.js';
export * from './session-config.js';
export * from './wire.js';
export * from './cost.js';
export * from './transport.js';
export * from './turn.js';
export * from './window.js';
export * from './transcript.js';
export * from './commands.js';
export * from './session.js';
