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
 * Contracts only — no behaviour yet. Every `declare`d function is a signature waiting for
 * REPO_SKELETON.md §10 step 7; the shapes are docs/design/voice-input-architecture.md §5, §6 and
 * §7.2, and §15 of that document maps each section to a file here.
 */

export type * from './types.js';
export type * from './credentials.js';
export type * from './session-config.js';
export type * from './transport.js';
export type * from './wire.js';
export type * from './turn.js';
export type * from './window.js';
export type * from './transcript.js';
export type * from './commands.js';
export type * from './cost.js';
export type * from './session.js';
