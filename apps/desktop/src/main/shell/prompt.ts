/**
 * The session instructions — everything the model is told before it is told anything about a turn.
 *
 * This is the cached prefix: `packages/realtime` puts it in `session.update` once per match and it
 * is billed once, so a change here rewrites the prefix and busts the cache for the rest of the
 * session (ADR-0011). Two properties follow and both are asserted by test:
 *
 * - **Pure in its input.** The same draft produces byte-identical text, because a reconnect
 *   re-assembles it and a new session that cannot cache the prefix it already paid for has thrown
 *   away the reason a prefix exists. Nothing here reads a clock, a world model or a global.
 * - **Total.** An empty draft still produces working instructions. A match whose draft never
 *   arrived is a match where Riki knows less, not one where it does not start.
 *
 * ## Why the draft comes off the lifecycle event and not off the world model
 *
 * ⚠ **The world model is empty at `match_started`, on purpose.** `main/state/index.ts` resets the
 * store *before* it announces — *"a listener rebuilding the preamble reads the world model, and
 * reading the previous match's facts is exactly the wrongness §6.4 is about"* — so anything that
 * reads `state.world` on that edge gets nothing, and gets it silently.
 *
 * The deleted preamble assembler did exactly that, through `buildPreambleInput(matchId,
 * state.world, …)`, for as long as it existed: every prefix it ever produced said `allies: |
 * enemies:` and nothing anywhere reported it. It surfaced by launching the app and reading the
 * instructions it actually sent. `MatchLifecycleEvent` carries `heroes` for this reason — it is the
 * draft off the payload that *announced* the match, so it survives the reset.
 *
 * `heroes` is empty when `match_started` is seen mid-match rather than during the draft, which is
 * ordinary: GSI's `draft` block is only populated in the draft phase. The per-turn snapshot carries
 * the roster accurately either way, so what the prefix loses is a cheap hint rather than a fact.
 *
 * ## What this replaced
 *
 * `packages/context`'s Tier 1 preamble assembler: seven section builders, an enrichment planner
 * racing a `ReferenceDataPort` against a 3-second deadline, a per-section token budget, and a
 * durable player-memory store feeding a `history` section. ADR-0042 deleted all of it. Most of what
 * it assembled existed to make a *coach* better at deciding when to interrupt you; what a model
 * answering questions needs is to know which heroes are in the game and how to talk about a fact it
 * cannot see.
 *
 * ⚠ **The persona and the staleness rules below are placeholders, and knowingly thin.** T8 of the
 * conversational migration owns this module and will rewrite it against the tool surface: two hard
 * rules — call a tool before any factual claim about the match, and never state an aged value as
 * current — plus the staleness reasoning lifted verbatim from the deleted coach prompt. What is
 * here now is the minimum that makes a spoken answer usable, not a finished prompt.
 */

/**
 * Who Riki is, and the one rule that survives the trigger engine intact.
 *
 * The staleness paragraph is the part worth keeping verbatim from the deleted coach prompt: the
 * whole of `packages/world-model`'s fact envelope is wasted if the thing reading it flattens a
 * thirty-second-old minimap blob into the present tense.
 */
const PERSONA = [
  'You are Riki, a Dota 2 assistant. The player is in a match right now and is talking to you',
  'through a push-to-talk key. Answer the question they asked, in one or two spoken sentences.',
  'You are not a coach: do not volunteer advice, do not tell them what to do next, and do not',
  'comment on how they are playing unless they ask.',
  '',
  'Every turn you are given a snapshot of the match. It carries an age and a confidence on facts',
  'that were not observed directly, and you must not state an aged value as current: say "was',
  'bottom thirty seconds ago", not "is bottom". If the snapshot does not say, say you cannot see',
  'it. A confident wrong answer about where an enemy is can get the player killed.',
].join(' ');

/**
 * The instructions for one match.
 *
 * `heroes` is the ten from the draft, unsplit: `MatchLifecycleEvent` reports them as one list
 * because GSI's `draft` block gives no team on a pick, and guessing which five are the enemy's
 * would be a fabrication in the one place that is never re-read. **The snapshot names the player's
 * hero and the enemy team accurately on every turn**, so the split lives there, where it is
 * observed rather than inferred.
 */
export function buildSessionPrompt(heroes: readonly string[]): string {
  if (heroes.length === 0) return PERSONA;
  const draft =
    `The heroes in this match are: ${heroes.join(', ')}. ` +
    'Which of them the player is, and which are the enemy team, is in the per-turn snapshot.';
  return `${PERSONA}\n\n${draft}`;
}
