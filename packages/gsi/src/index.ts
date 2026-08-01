/**
 * @riki/gsi
 *
 * Receives Dota 2's Game State Integration POSTs: HTTP listener, token auth, parsing into
 * protocol types, and liveness/heartbeat tracking so a silent client is detectable.
 *
 * Inputs arrive at 2–8 Hz. FakeGsiSource in `@riki/gsi/testing` replays fixtures/gsi/*.jsonl,
 * which is what lets every consumer be tested without Dota running (§5.2).
 *
 * Shapes are docs/design/state-capture-architecture.md §4.1. `createGsiServer` composes the
 * other five; they are exported separately so each can be tested without a socket.
 */

export type * from './contracts.js';
export type * from './payload.js';
export * from './auth.js';
export * from './clock.js';
export * from './liveness.js';
export * from './parse.js';
export * from './server.js';
export * from './session.js';
