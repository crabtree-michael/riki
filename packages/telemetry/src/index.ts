/**
 * @riki/telemetry
 *
 * Structured logging, perf counters, and the redaction rules that run before anything reaches a
 * sink — chat text, Steam IDs, and the API key.
 *
 * The only package permitted to call `console.*` (§6.2): everything else logs through here so
 * redaction cannot be bypassed by accident.
 *
 * Skeleton only — no implementation yet. See REPO_SKELETON.md §2.2 for what belongs here
 * and §10 for where this package sits in the scaffolding order.
 */

export {};
