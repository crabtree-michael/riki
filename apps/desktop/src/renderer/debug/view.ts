/**
 * A `DebugFrame`, as a document.
 *
 * Pure and total: one function per panel, each taking a slice of the frame and returning an
 * element. No subscription, no timer, no bridge — `app.ts` owns all three. The split is the same
 * one the overlay's `view/` uses and it buys the same thing: every panel here is a Tier 1 test
 * against `happy-dom`, with no game, no window and no IPC (the `testing` skill's fifth project).
 *
 * ## Two rules the whole file follows
 *
 * **`textContent`, never `innerHTML`.** Everything on this screen came from a Dota client, a
 * detector's phrasing, or a rendered brief — none of it is ours, and the document's CSP would stop
 * a script running but not a layout being wrecked by a stray angle bracket in a hero name.
 *
 * **Nothing is inferred.** Where the frame says a value is null, the panel says so rather than
 * showing a plausible zero: "never observed" and "observed to be zero" are different claims, and
 * `packages/world-model` goes to some trouble to keep them apart. Undoing that in the one view
 * built to inspect it would be the worst place to undo it.
 */

import type {
  DebugCandidate,
  DebugCount,
  DebugFrame,
  DebugGateState,
  DebugProblem,
  DebugTick,
  DebugTurn,
  DebugWorld,
} from '../../shared/debug.js';

export interface ViewOptions {
  /**
   * Hide ticks whose every candidate was refused by gate 1.
   *
   * On by default, and it is the difference between a usable panel and a wall. `not_in_match`
   * covers the draft, the post-game screen, and every Turbo or Ability Draft game — during which
   * the detectors keep producing candidates on every version bump and the ladder refuses all of
   * them at the first question. Those ticks are correct and there are thousands of them.
   */
  readonly hideNotInMatch: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = { hideNotInMatch: true };

// -----------------------------------------------------------------------------------------------
// Element helpers
// -----------------------------------------------------------------------------------------------

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stat(label: string, value: string): HTMLElement {
  const wrap = el('div', 'ins-stat');
  wrap.append(el('span', 'ins-stat-label', label), el('span', 'ins-stat-value', value));
  return wrap;
}

function pill(text: string, tone: 'off' | 'on' | 'good' | 'bad'): HTMLElement {
  const suffix = tone === 'off' ? '' : ` ins-pill--${tone}`;
  return el('span', `ins-pill${suffix}`, text);
}

function panel(title: string, note: string | null, body: HTMLElement): HTMLElement {
  const wrap = el('section', 'ins-panel');
  const head = el('div', 'ins-panel-title', title);
  if (note !== null) {
    head.append(document.createTextNode(' '), el('span', 'ins-panel-note', note));
  }
  wrap.append(head, body);
  return wrap;
}

function empty(message: string): HTMLElement {
  return el('div', 'ins-empty', message);
}

// -----------------------------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------------------------

/** Match clock as `m:ss`, or `—` before the horn. Null is not zero: 0:00 is a real moment. */
export function formatClock(seconds: number | null): string {
  if (seconds === null) return '—';
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(Math.floor(seconds));
  const mins = Math.floor(total / 60);
  return `${sign}${String(mins)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatAge(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${String(Math.round(ms / 60_000))}m`;
}

/** Three decimals: salience thresholds are tuned in the third one, so two would hide the answer. */
export function formatScore(value: number): string {
  return value.toFixed(3);
}

function counts(list: readonly DebugCount[]): string {
  const nonZero = list.filter((entry) => entry.count > 0);
  if (nonZero.length === 0) return 'none';
  return nonZero.map((entry) => `${entry.key} ${String(entry.count)}`).join('  ');
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// -----------------------------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------------------------

export function renderHeader(frame: DebugFrame): HTMLElement {
  const head = el('header', 'ins-header');
  const { session, world, counters } = frame;

  head.append(
    stat('match', session.matchId ?? 'none'),
    stat('clock', formatClock(world.clock)),
    stat('version', `${String(world.version)} @ ${world.versionsPerSecond.toFixed(1)}/s`),
    stat('chip', session.chipPhase),
    // Before the counters, because it says what the counters *can* contain: under `llm` there is no
    // gate ladder and no `packages/events`, so a Triggers panel of bare decisions and an empty
    // Counters panel are correct rather than broken.
    stat('coach', session.coachMode),
    stat('health', `${session.health.level} · ${session.health.summary}`),
    stat('triggers', `${String(counters.spoken)} spoken / ${plural(counters.ticks, 'tick')}`),
  );

  // The disagreement worth surfacing at the top: a live match with no coaching root means
  // `match_started` reached the state subsystem and never reached the shell, and every panel below
  // would look plausibly empty.
  if (session.matchId !== null && !session.coachingRoot) {
    head.append(pill('no coaching root', 'bad'));
  }
  if (world.paused) head.append(pill('paused', 'on'));
  if (session.muted) head.append(pill('muted', 'on'));
  if (session.chipVisible) head.append(pill('chip visible', 'off'));

  return head;
}

// -----------------------------------------------------------------------------------------------
// Switches
// -----------------------------------------------------------------------------------------------

export function renderGates(gates: DebugGateState, now: number): HTMLElement {
  const body = el('div');

  const row = el('div', 'ins-row');
  const flags = el('div', 'ins-value');
  flags.append(
    pill('quiet mode', gates.quietMode ? 'on' : 'off'),
    pill('agent speaking', gates.agentSpeaking ? 'on' : 'off'),
    pill('player speaking', gates.playerSpeaking ? 'on' : 'off'),
    pill(
      gates.mutedUntilMs === null
        ? 'not muted'
        : `muted ${formatAge(Math.max(0, gates.mutedUntilMs - now))}`,
      gates.mutedUntilMs !== null && gates.mutedUntilMs > now ? 'on' : 'off',
    ),
    pill(gates.unprompted ? 'unprompted on' : 'unprompted off', gates.unprompted ? 'good' : 'on'),
  );
  row.append(el('span', 'ins-key', 'switches'), flags, el('span', 'ins-meta', ''));
  body.append(row);

  body.append(
    plainRow(
      'intensity',
      `${formatScore(gates.intensity)} / ${formatScore(gates.intensityThreshold)}`,
      gates.intensity >= gates.intensityThreshold ? 'refuses high_intensity' : '',
    ),
    plainRow('speak threshold', formatScore(gates.speakThreshold), ''),
    plainRow(
      'global cooldown',
      gates.lastSpokeAtMs === null
        ? 'never spoken'
        : `${formatAge(Math.max(0, gates.globalCooldownMs - (now - gates.lastSpokeAtMs)))} left`,
      gates.lastSpokeAtMs === null ? '' : `last ${formatAge(now - gates.lastSpokeAtMs)} ago`,
    ),
    plainRow('latched', gates.latched.length === 0 ? 'none' : gates.latched.join(', '), ''),
    plainRow(
      'kind cooldowns',
      gates.kindCooldowns.length === 0
        ? 'none running'
        : gates.kindCooldowns
            .map((cooldown) => `${cooldown.kind} ${formatAge(cooldown.remainingMs)}`)
            .join(', '),
      '',
    ),
  );

  // Said rather than implied. These numbers come off the last `GateContext`, which is assembled on
  // a world-model version bump — so between bumps they are a still frame, and a cooldown that reads
  // "2.1s left" has stopped counting down.
  const note =
    gates.asOfMs === null
      ? 'no tick yet — the engine has not run'
      : `as of the last tick, ${formatAge(now - gates.asOfMs)} ago`;

  return panel('Gate state', note, body);
}

function plainRow(key: string, value: string, meta: string): HTMLElement {
  const row = el('div', 'ins-row');
  row.append(
    el('span', 'ins-key', key),
    el('span', 'ins-value', value),
    el('span', 'ins-meta', meta),
  );
  return row;
}

// -----------------------------------------------------------------------------------------------
// World
// -----------------------------------------------------------------------------------------------

export function renderWorld(world: DebugWorld): HTMLElement {
  const body = el('div');

  if (world.facts.length === 0) {
    body.append(empty('nothing observed yet'));
  } else {
    for (const fact of world.facts) {
      const row = el('div', 'ins-row');
      const meta = el('span', `ins-meta ins-${fact.staleness}`);
      // The full envelope, every row: source, confidence, age, and the basis the age was measured
      // on. The basis is the one that explains an age that looks wrong during a pause.
      meta.textContent = `${fact.source} ${fact.confidence.toFixed(2)} · ${formatAge(fact.ageMs)} ${fact.ageBasis} · ${fact.staleness}`;
      row.append(el('span', 'ins-key', fact.path), el('span', 'ins-value', fact.value), meta);
      body.append(row);
    }
  }

  return panel('World model', `v${String(world.version)}`, body);
}

export function renderEnemies(world: DebugWorld): HTMLElement {
  const body = el('div');

  if (world.enemies.length === 0) {
    body.append(
      empty('no enemies observed — the sidecar writes these, and it speaks no protocol yet'),
    );
  } else {
    for (const enemy of world.enemies) {
      const row = el('div', 'ins-row');
      // A position, or — when it has expired — where they were last seen, which outlives it by two
      // minutes on purpose (`world-model/state.ts`, `EnemyState.lastSeenAt`).
      const value = enemy.position ?? `last seen ${enemy.lastSeenAt ?? 'never'}`;
      const meta = el('span', `ins-meta ins-${enemy.staleness}`);
      meta.textContent = [
        enemy.alive === null ? 'alive?' : enemy.alive ? 'alive' : 'dead',
        enemy.level === null ? 'lvl?' : `lvl ${String(enemy.level)}`,
        enemy.staleness,
      ].join(' · ');
      row.append(el('span', 'ins-key', enemy.hero), el('span', 'ins-value', value), meta);
      body.append(row);
      if (enemy.itemsSeen.length > 0) {
        body.append(plainRow('', `items: ${enemy.itemsSeen.join(', ')}`, ''));
      }
    }
  }

  return panel('Enemies', null, body);
}

export function renderDerived(world: DebugWorld): HTMLElement {
  const body = el('div');

  if (world.derived.length === 0) {
    body.append(empty('no derived rules registered'));
  } else {
    for (const rule of world.derived) {
      body.append(
        plainRow(
          rule.id,
          // Null is the rule declining because its inputs were too stale to answer honestly, which
          // is the design (`derived/registry.ts`) and is not the same as a zero.
          rule.value ?? 'null — inputs too stale to answer',
          rule.confidence === null ? '' : rule.confidence.toFixed(2),
        ),
      );
    }
  }

  return panel('Derived', null, body);
}

// -----------------------------------------------------------------------------------------------
// Ticks — the gate ladder
// -----------------------------------------------------------------------------------------------

/** True when every candidate in the tick died at gate 1. See `ViewOptions.hideNotInMatch`. */
export function isNotInMatchTick(tick: DebugTick): boolean {
  return (
    tick.candidates.length > 0 &&
    tick.candidates.every((candidate) =>
      candidate.ladder.some((gate) => gate.reason === 'not_in_match' && gate.refuses),
    )
  );
}

export function renderTicks(frame: DebugFrame, options: ViewOptions): HTMLElement {
  const shown = options.hideNotInMatch
    ? frame.ticks.filter((tick) => !isNotInMatchTick(tick))
    : frame.ticks;

  const body = el('div');
  if (shown.length === 0) {
    body.append(
      empty(
        frame.counters.ticks === 0
          ? 'the engine has not ticked — no match, or no world-model versions'
          : `${String(frame.counters.ticks)} ticks, none with a candidate past gate 1`,
      ),
    );
  } else {
    // Newest first here, unlike the buffer: the question is always about what just happened.
    for (const tick of [...shown].reverse()) body.append(renderTick(tick));
  }

  const hidden = frame.ticks.length - shown.length;
  return panel(
    'Triggers',
    hidden > 0 ? `${plural(hidden, 'not_in_match tick')} hidden` : null,
    body,
  );
}

function renderTick(tick: DebugTick): HTMLElement {
  const wrap = el('div', tick.decision.speak ? 'ins-tick ins-tick--spoke' : 'ins-tick');

  const head = el('div', 'ins-tick-head');
  head.append(
    el('span', undefined, `#${String(tick.seq)}`),
    el('span', undefined, formatClock(tick.clock)),
    el('span', 'ins-meta', `v${String(tick.worldVersion)}`),
    tick.decision.speak
      ? pill(`spoke: ${tick.decision.key}`, 'good')
      : // `key === null` is the LLM coach declining, and its reason is a sentence worth reading on
        // its own. The deterministic coach's "nothing was detected" tick never reaches this buffer
        // — `hub.recordTick` drops a tick with no candidates — so there is no third case here.
        pill(
          tick.decision.key === null ? tick.decision.reason : `refused: ${tick.decision.reason}`,
          'bad',
        ),
  );
  wrap.append(head);

  // Empty under the LLM coach, where the decision in the head above is the whole of what that coach
  // has to say about a moment — no detectors, no salience, no ladder to grid.
  for (const candidate of tick.candidates) wrap.append(renderCandidate(candidate));
  return wrap;
}

function renderCandidate(candidate: DebugCandidate): HTMLElement {
  const wrap = el(
    'div',
    candidate.rank === 'winner' ? 'ins-candidate ins-candidate--winner' : 'ins-candidate',
  );

  const head = el('div', 'ins-candidate-head');
  head.append(
    el('span', undefined, candidate.key),
    el('span', 'ins-meta', `salience ${formatScore(candidate.salience)}`),
    el(
      'span',
      'ins-meta',
      `mag ${formatScore(candidate.magnitude)} · conf ${formatScore(candidate.confidence)}`,
    ),
    el(
      'span',
      'ins-meta',
      candidate.actWithinSeconds === null
        ? 'no deadline'
        : `act within ${String(candidate.actWithinSeconds)}s`,
    ),
  );
  if (candidate.rank === 'winner') head.append(pill('winner', 'off'));
  if (candidate.taped) head.append(pill('taped', 'off'));
  wrap.append(head, el('div', 'ins-candidate-text', candidate.text));

  // The ladder in full, including the gates that passed. The first refusal is the one that decided
  // it and is styled as such; later refusals are shadowed, because "would also have refused" is a
  // different fact from "refused" and tuning the first one is wasted if the second is still there.
  const ladder = el('div', 'ins-ladder');
  let decided = false;
  for (const gate of candidate.ladder) {
    let tone: string;
    if (!gate.refuses) {
      tone = 'pass';
    } else if (decided) {
      tone = 'shadowed';
    } else {
      tone = 'refuse';
      decided = true;
    }
    ladder.append(el('span', `ins-gate ins-gate--${tone}`, gate.reason));
  }
  wrap.append(ladder);

  return wrap;
}

// -----------------------------------------------------------------------------------------------
// Turns — what the coach was given and what it said
// -----------------------------------------------------------------------------------------------

export function renderTurns(frame: DebugFrame): HTMLElement {
  const body = el('div');
  if (frame.turns.length === 0) {
    body.append(empty('no turns yet'));
  } else {
    for (const turn of [...frame.turns].reverse()) body.append(renderTurn(turn));
  }
  return panel('Coach turns', null, body);
}

function renderTurn(turn: DebugTurn): HTMLElement {
  const wrap = el('div', 'ins-turn');

  const head = el('div', 'ins-turn-head');
  head.append(
    el('span', undefined, turn.turnId),
    el('span', 'ins-meta', formatClock(turn.clock)),
    pill(
      turn.eventId === null ? turn.cause : `${turn.cause}: ${turn.eventId}`,
      turn.cause === 'trigger' ? 'off' : 'good',
    ),
    pill(turn.outcome, turn.outcome === 'spoke' ? 'good' : turn.outcome === 'open' ? 'off' : 'on'),
  );
  if (turn.salience !== null) {
    head.append(el('span', 'ins-meta', `salience ${formatScore(turn.salience)}`));
  }
  head.append(
    el('span', 'ins-meta', `${String(turn.snapshotTokens)} + ${String(turn.briefTokens)} tokens`),
  );
  wrap.append(head);

  wrap.append(el('div', 'ins-text-label', 'snapshot'), el('pre', 'ins-text', turn.snapshotText));

  if (turn.briefEmpty) {
    // The whole point of recording this: the trigger cleared thirteen gates and then produced
    // nothing to say, which is a defect in `BRIEF_PLAN` and reads as ordinary silence everywhere
    // else (coaching-architecture.md §6.5).
    wrap.append(
      el('div', 'ins-text-label', 'brief'),
      el('div', 'ins-empty', 'empty — the turn was admitted and closed silent'),
    );
  } else {
    wrap.append(
      el(
        'div',
        'ins-text-label',
        `brief · ${turn.briefSections.join(', ')}${turn.briefOmitted.length > 0 ? ` · omitted: ${turn.briefOmitted.join(', ')}` : ''}`,
      ),
      el('pre', 'ins-text ins-text--brief', turn.briefText),
    );
  }

  if (turn.agentSaid !== null) {
    wrap.append(
      el('div', 'ins-text-label', 'riki said'),
      el('pre', 'ins-text ins-text--said', turn.agentSaid),
    );
  }
  if (turn.playerSaidChars !== null) {
    // Deliberately a length. The player's own words are the one thing in this process that is
    // nobody's business but theirs (`shared/debug.ts`).
    wrap.append(
      el(
        'div',
        'ins-text-label',
        `player said ${String(turn.playerSaidChars)} characters (not shown)`,
      ),
    );
  }

  return wrap;
}

// -----------------------------------------------------------------------------------------------
// Counters and problems
// -----------------------------------------------------------------------------------------------

export function renderCounters(frame: DebugFrame): HTMLElement {
  const body = el('div');
  body.append(
    plainRow('detected', counts(frame.counters.detected), ''),
    plainRow('suppressed', counts(frame.counters.suppressed), ''),
    plainRow('spoken', String(frame.counters.spoken), ''),
    plainRow(
      'empty briefs',
      String(frame.counters.emptyBriefs),
      frame.counters.emptyBriefs > 0 ? 'admitted and dropped' : '',
    ),
    plainRow('bus depth', String(frame.session.health.bus.depth), ''),
    plainRow('dropped', counts(frame.session.health.bus.dropped), ''),
    plainRow('seq gaps', counts(frame.session.health.bus.gaps), ''),
  );

  for (const source of frame.session.health.sources) {
    body.append(
      plainRow(
        source.id,
        source.reason === null ? source.state : `${source.state} — ${source.reason}`,
        [
          source.lastObservationAgoMs === null
            ? 'never'
            : `${formatAge(source.lastObservationAgoMs)} ago`,
          source.restarts > 0 ? `${String(source.restarts)} restarts` : '',
        ]
          .filter((part) => part !== '')
          .join(' · '),
      ),
    );
  }

  return panel('Counters and sources', null, body);
}

export function renderProblems(problems: readonly DebugProblem[], now: number): HTMLElement {
  const body = el('div');
  if (problems.length === 0) {
    body.append(empty('nothing has gone wrong'));
  } else {
    for (const problem of [...problems].reverse()) {
      const row = el('div', 'ins-problem');
      row.append(
        // Relative to the frame, because `at` is main's monotonic clock and means nothing on its
        // own — the renderer has no access to that clock and must never compare against its own.
        el('span', 'ins-meta', `${formatAge(Math.max(0, now - problem.at))} ago`),
        el('span', 'ins-problem-origin', problem.origin),
        el('span', 'ins-problem-message', problem.message),
      );
      body.append(row);
    }
  }
  return panel('Problems', null, body);
}
