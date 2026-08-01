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
 * Skeleton only — no implementation yet. See REPO_SKELETON.md §2.2 for what belongs here
 * and §10 for where this package sits in the scaffolding order.
 */

export {};
