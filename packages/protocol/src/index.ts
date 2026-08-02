/**
 * @riki/protocol
 *
 * Every message that crosses a process or language boundary is defined here: Electron main
 * ↔ renderer, and Electron ↔ the Rust sidecar.
 *
 * Rules (REPO_SKELETON.md §4): zod is the source of truth; JSON Schema and the Rust types in
 * crates/riki-ipc are generated from it by `pnpm codegen`; every message is versioned; and
 * confidence, provenance and timestamps are non-optional on every CV-derived fact.
 *
 * Changing this package is a coordination event — say so in the commit message.
 *
 * ## What is here, and what is not yet
 *
 * The sidecar stdio protocol (`schemas/sidecar.ts`) and its transport (`codec.ts`). The main ↔
 * renderer messages are **not** here: they live in `apps/desktop/src/shared`, which is where they
 * were written before this package had any schemas. Moving them is a coordination event of its
 * own rather than a detail of this one, and they cross a process boundary but not a language one,
 * so nothing generates from them today.
 */

export { PROTOCOL_VERSION } from './version.js';
export * from './schemas/sidecar.js';
export { commands, decodeSidecarEvent, encodeMessage, type DecodedEvent } from './codec.js';
