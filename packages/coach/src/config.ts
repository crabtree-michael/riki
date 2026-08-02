/**
 * Every number that changes behaviour, in one object.
 *
 * The same rule `packages/events/config.ts` holds, for the same reason: tuning is a diff to one
 * file. Nothing else in this package holds a numeric literal that affects behaviour, and if you
 * find one, it belongs here.
 *
 * **There is no cost budget here, and the one latency budget is not a request timeout.** The coach
 * runs a flagship model and takes as long as it takes, except where a detector has said how long its
 * own advice stays useful — see `minDeadlineSeconds` and §4.6. The day cost matters, `model` and
 * `maxTurns` are the knobs to turn, and §8 is the arithmetic.
 *
 * See docs/design/llm-coach-architecture.md §3.
 */

/**
 * The default model.
 *
 * A flagship rather than a mini tier, because quality of judgement is the thing being optimised and
 * this coach makes exactly one decision per consultation. The whole product hangs on that decision
 * being good; it does not hang on it being cheap yet.
 *
 * *(tunable, unmeasured — `RIKI_COACH_MODEL`)*
 */
export const DEFAULT_COACH_MODEL = 'gpt-5.4';

export interface LlmCoachConfig {
  /** Any id the Responses API accepts. Resolved by `@openai/agents`' provider, not by us. */
  readonly model: string;

  /**
   * The shortest gap between two consultations *(tunable, unmeasured)*.
   *
   * Not a cooldown on *speech* — the model owns that decision — but on *asking*. The coach is woken
   * by a fresh detection and detections can flap: a hero crossing the edge of vision produces
   * `enemy_missing:sf` again and again, and each reappearance is honestly new. Two seconds is short
   * enough that a kill is judged while it still matters, and long enough that a flapping detector
   * cannot put a dozen requests in flight against a coach that answers one at a time.
   */
  readonly minConsultGapSeconds: number;

  /**
   * The floor under a derived deadline, in seconds *(tunable, unmeasured)*.
   *
   * §4.6's deadline comes from the detectors — `low_hp_no_escape` says its advice is worth five
   * seconds — and a detector is free to declare a window no network round trip could ever meet. This
   * is the admission that a one-second window cannot be served: below it the deadline is raised to
   * this, so the request gets a fair chance rather than a guaranteed abort.
   *
   * Three seconds is deliberately under the tightest detector window in the repo (five), so that
   * `low_hp_no_escape`'s real deadline is its own and not this number in disguise. If a change here
   * starts clamping a live detector, that is the signal to change the detector.
   */
  readonly minDeadlineSeconds: number;

  /** How many of the coach's own recent utterances it is shown *(tunable, unmeasured)*. */
  readonly spokenHistoryDepth: number;

  /**
   * How many detected signals are rendered into one stimulus *(tunable, unmeasured)*.
   *
   * Ordered fresh first, then by magnitude. A cap rather than a filter: a stimulus that listed every
   * true condition in a chaotic teamfight would bury the two that matter, and the model has no
   * salience score to sort by because this package deliberately does not send it one.
   *
   * It is also the set an answer is validated against (§2.2), so a signal dropped here is a signal
   * the model may not speak about. That is the correct direction — it was never shown it.
   */
  readonly maxSignals: number;

  /**
   * The ceiling on what the model may say, in characters *(tunable, unmeasured)*.
   *
   * Not a style rule; the prompt asks for one or two sentences and this is not that number. It is a
   * window guard: the line is injected into the Realtime conversation alongside the brief, and
   * `packages/context`'s compactor budgets what it can see. Three hundred characters is roughly
   * seventy-five tokens, under half of what the brief beside it costs. A longer answer is discarded
   * rather than truncated — half a sentence spoken aloud is worse than silence.
   */
  readonly maxSayChars: number;

  /**
   * Tool-call rounds the agent may take before the run is abandoned *(tunable, unmeasured)*.
   *
   * Three is enough for a roster call, a hero lookup and an answer, which is the shape §5 expects.
   * The failure this bounds is a model that loops on the library rather than judging.
   */
  readonly maxTurns: number;

  /**
   * **Off, and it is a privacy default rather than a performance one.**
   *
   * The Agents SDK's tracing exporter posts prompts, tool arguments and outputs to OpenAI's traces
   * endpoint as a side channel to the model call itself. A stimulus contains the rendered world
   * snapshot; `state-capture` §4.2 tags chat text `sensitive` and dota2 §7 requires a Steam ID be
   * hashed before any egress, and neither rule was written with a second, unlogged destination in
   * mind. So the default is off, `coach.test.ts` asserts it, and turning it on is a deliberate act
   * by someone who has read this paragraph.
   */
  readonly tracing: boolean;
}

export const DEFAULT_COACH_CONFIG: LlmCoachConfig = {
  model: DEFAULT_COACH_MODEL,
  minConsultGapSeconds: 2,
  minDeadlineSeconds: 3,
  spokenHistoryDepth: 6,
  maxSignals: 6,
  maxSayChars: 300,
  maxTurns: 3,
  tracing: false,
};

/** Partial override, for a test or a settings file. The same shape `withTriggerConfig` has. */
export function withCoachConfig(overrides: Partial<LlmCoachConfig>): LlmCoachConfig {
  return { ...DEFAULT_COACH_CONFIG, ...overrides };
}
