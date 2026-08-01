/**
 * @riki/config
 *
 * Resolves configuration once at startup and hands it out by injection thereafter.
 *
 * Layered, highest wins: CLI flags → environment → user config file → committed defaults.
 * Validated with zod; invalid config fails at startup with a message naming the offending key
 * rather than half-booting.
 *
 * This is the only module in the repo permitted to read `process.env` — a lint rule enforces
 * it (§6.2). That is what keeps RIKI_OPENAI_API_KEY (§7.1) traceable to one auditable file, and
 * what makes replacing the env-var scheme at distribution time a one-file change.
 *
 * Skeleton only — no implementation yet. See REPO_SKELETON.md §2.2 for what belongs here
 * and §10 for where this package sits in the scaffolding order.
 */

export {};
