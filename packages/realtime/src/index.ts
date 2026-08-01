/**
 * @riki/realtime
 *
 * Owns the OpenAI Realtime session: transport, event bus, barge-in with
 * conversation.item.truncate, context retention policy, and cost accounting.
 *
 * The only package permitted to import the `openai` SDK (§6.2). It receives the API key
 * injected from @riki/config and never reads the environment itself (§7.1).
 *
 * Skeleton only — no implementation yet. See REPO_SKELETON.md §2.2 for what belongs here
 * and §10 for where this package sits in the scaffolding order.
 */

export {};
