/**
 * The wire version, and the two fields that may never change shape.
 *
 * REPO_SKELETON.md §4: the sidecar and the app are routinely different builds during development,
 * and a version mismatch must produce a clear error rather than a confusing parse failure three
 * layers down. That only works if a mismatched message is still *parseable enough* to recognise as
 * a mismatch — so `v` and `type` are frozen for all time. Everything else in every message may be
 * added to, renamed, or removed under a version bump; those two may not.
 *
 * Bump `PROTOCOL_VERSION` whenever a message changes in a way an older peer would misread. The
 * Rust side does not get its own copy to drift out of sync — `crates/riki-ipc/src/generated`
 * receives this constant from `pnpm codegen`.
 */

/** Incremented on any breaking change to a message in this package. */
export const PROTOCOL_VERSION = 1;
