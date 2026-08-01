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
 * Implemented: the GA session builder and its assertion (`session-config`), the server-event
 * parser (`wire`), cost accounting (`cost`), and the ephemeral-secret broker (`credentials`).
 * Still contracts: the transports, the turn controller, the window executor, the transcript
 * stream, the local command parser and the session facade — those need a peer connection or a
 * live capture graph and land with the voice window (REPO_SKELETON.md §10 step 6/7).
 * §15 of the design document maps each section to a file here.
 *
 * Three things to know before changing anything here, each a documented failure that produces no
 * error at all:
 *
 * 1. **The GA schema is not the beta schema.** `session-config.ts` is the only producer of a wire
 *    payload, and `assertGaShape` runs on the way out.
 * 2. **VAD stays on** (ADR-0017) so server-side barge-in truncation keeps working; the gesture,
 *    not the model, decides when a response is created.
 * 3. **The key is an `ApiKey`, not a string** (ADR-0022), so it cannot reach a log by accident.
 */

export type * from './types.js';
export type * from './transport.js';
export type * from './turn.js';
export type * from './window.js';
export type * from './transcript.js';
export type * from './commands.js';
export type * from './session.js';

export * from './credentials.js';
export * from './session-config.js';
export * from './wire.js';
export * from './cost.js';
