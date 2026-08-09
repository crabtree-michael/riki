/**
 * A `DebugFrame`, as a document.
 *
 * Pure and total: one function per panel, each taking a slice of the frame and returning an
 * element. No subscription, no timer, no bridge — `app.ts` owns all three. The split is the same
 * one the overlay's `view/` uses and it buys the same thing: every panel here is a Tier 1 test
 * against `happy-dom`, with no game, no window and no IPC (the `testing` skill's fifth project).
 *
 * ## Three rules the whole file follows
 *
 * **`textContent`, never `innerHTML`.** Everything on this screen came from a Dota client or a
 * rendered snapshot — none of it is ours, and the document's CSP would stop a script running but
 * not a layout being wrecked by a stray angle bracket in a hero name.
 *
 * **Nothing is inferred.** Where the frame says a value is null, the panel says so rather than
 * showing a plausible zero: "never observed" and "observed to be zero" are different claims, and
 * `packages/world-model` goes to some trouble to keep them apart. Undoing that in the one view
 * built to inspect it would be the worst place to undo it.
 *
 * **Anything repeated carries a `data-ins-key`.** A turn, a fact, a trace step — each is stamped
 * with an identity that survives the next frame, which is the whole of what `scroll.ts` needs to
 * put the reader back where they were after the document is rebuilt underneath them. The key is
 * derived from the frame (a `seq`, a `turnId`, a fact path), never from render order, because
 * render order is exactly what a new frame changes.
 *
 * The Triggers, Gate state, Counters, Controls and Rehearsal panels went with the trigger engine
 * they rendered (ADR-0042). What replaced them is inside the Turns panel: every tool call the model
 * made to answer, and a mark on the turns that made none (ADR-0047).
 */

import type {
  DebugAction,
  DebugCount,
  DebugFrame,
  DebugProblem,
  DebugToolCall,
  DebugTraceStep,
  DebugTurn,
  DebugWorld,
} from '../../shared/debug.js';

// -----------------------------------------------------------------------------------------------
// Element helpers
// -----------------------------------------------------------------------------------------------

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Stamps the identity `scroll.ts` finds this node by after the next redraw.
 *
 * Locally unique is enough — `panel()` namespaces every key beneath it by the panel's title, so
 * `row:spoken` in Counters cannot be confused with a `row:spoken` somewhere else in the column.
 */
function keyed(node: HTMLElement, key: string): HTMLElement {
  node.dataset.insKey = key;
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

  // Namespacing, in one pass rather than at every call site: the keys below are written to be
  // unique within their own panel, and this is what makes them unique within the scrolling column.
  // `Array.from` rather than iterating the NodeList: the renderer's `lib` is `DOM` without
  // `DOM.Iterable`, under which a `for…of` over one is silently `any`.
  for (const node of Array.from(wrap.querySelectorAll<HTMLElement>('[data-ins-key]'))) {
    node.dataset.insKey = `${title}/${node.dataset.insKey ?? ''}`;
  }
  return keyed(wrap, title);
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
  const { session, world } = frame;

  head.append(
    stat('match', session.matchId ?? 'none'),
    stat('clock', formatClock(world.clock)),
    stat('version', `${String(world.version)} @ ${world.versionsPerSecond.toFixed(1)}/s`),
    stat('chip', session.chipPhase),
    stat('health', `${session.health.level} · ${session.health.summary}`),
    stat('turns', plural(frame.turns.length, 'turn')),
  );

  // The disagreement worth surfacing at the top: a live match with no session means
  // `match_started` reached the state subsystem and never reached the shell, and every panel below
  // would look plausibly empty.
  if (session.matchId !== null && !session.matchSession) {
    head.append(pill('no session', 'bad'));
  }

  if (world.paused) head.append(pill('paused', 'on'));
  if (session.muted) head.append(pill('muted', 'on'));
  if (session.chipVisible) head.append(pill('chip visible', 'off'));

  return head;
}

// -----------------------------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------------------------

function plainRow(key: string, value: string, meta: string): HTMLElement {
  const row = el('div', 'ins-row');
  row.append(
    el('span', 'ins-key', key),
    el('span', 'ins-value', value),
    el('span', 'ins-meta', meta),
  );
  // The label is the identity: these rows are a fixed set per panel whose values change, so `key`
  // is stable across frames in a way an index would not be. The unlabelled ones — an enemy's item
  // line — are continuations of the row above and are anchored by it.
  return key === '' ? row : keyed(row, `row:${key}`);
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
      body.append(keyed(row, `fact:${fact.path}`));
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
      body.append(keyed(row, `enemy:${enemy.hero}`));
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
// Turns — what the model was given and what it said
// -----------------------------------------------------------------------------------------------

export function renderTurns(frame: DebugFrame): HTMLElement {
  const body = el('div');
  if (frame.turns.length === 0) {
    body.append(empty('no turns yet'));
  } else {
    for (const turn of [...frame.turns].reverse()) body.append(renderTurn(turn));
  }

  // Counted in the title as well as marked on the row, because the interesting reading is a rate:
  // one ungrounded answer is a question that did not need the world, and four in a row is a prompt
  // that has stopped working.
  const silent = frame.turns.filter(answeredWithoutTools).length;
  return panel(
    'Turns',
    silent === 0
      ? null
      : `${String(silent)} of ${plural(frame.turns.length, 'turn')} called no tool`,
    body,
  );
}

/**
 * A turn that spoke without asking the world anything.
 *
 * The failure conversational-architecture.md §10 names is narrower than this — *a **factual**
 * question answered with no tool call* — and this window cannot narrow it, because it never sees
 * the question. `playerSaidChars` is a length and the transcript is deliberately not carried
 * (`shared/debug.ts`), so "how many characters did they say" is the whole of what is knowable
 * about what was asked.
 *
 * So it over-flags, on purpose: "what time is it" and "say that again" are both marked, and both
 * are cheap for a reader to dismiss. The other direction is not cheap — an answer that sounds
 * grounded and was not is exactly the thing nobody catches by listening, and it is the reason this
 * mark exists at all. ADR-0047.
 */
export function answeredWithoutTools(turn: DebugTurn): boolean {
  return turn.outcome === 'spoke' && turn.tools.length === 0;
}

function renderTurn(turn: DebugTurn): HTMLElement {
  const ungrounded = answeredWithoutTools(turn);
  const wrap = el('div', `ins-turn${ungrounded ? ' ins-turn--no-tools' : ''}`);

  const head = el('div', 'ins-turn-head');
  head.append(
    el('span', undefined, turn.turnId),
    el('span', 'ins-meta', formatClock(turn.clock)),
    // `system` is the inspector's own `scenario.speak`; `player` is a key press. Distinguishing
    // them is load-bearing: a button press rendered as a question would make the one window built
    // to be believed lie about who asked.
    pill(turn.cause, turn.cause === 'player' ? 'good' : 'on'),
    pill(turn.outcome, turn.outcome === 'spoke' ? 'good' : turn.outcome === 'open' ? 'off' : 'on'),
  );
  if (ungrounded) head.append(pill('no tool call', 'bad'));
  head.append(
    el('span', 'ins-meta', `${String(turn.snapshotTokens)} tokens`),
    el('span', 'ins-meta', formatLegs(turn)),
  );
  wrap.append(head);

  wrap.append(
    el(
      'div',
      'ins-text-label',
      `snapshot${turn.snapshotOmitted.length > 0 ? ` · omitted: ${turn.snapshotOmitted.join(', ')}` : ''}`,
    ),
    el('pre', 'ins-text', turn.snapshotText),
  );

  wrap.append(el('div', 'ins-text-label', 'tool calls'), renderToolCalls(turn));

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

  return keyed(wrap, `turn:${turn.turnId}`);
}

/**
 * Every call the model made inside this turn, oldest first.
 *
 * Oldest first and not newest first, unlike the panels around it: a turn's calls are read as a
 * sequence — *it asked for its own state, then for the enemy it was worried about* — and the order
 * it asked in is most of what that says.
 *
 * The empty case is a message rather than an absence for the same reason the row is marked: a turn
 * with no calls looks identical to a turn whose calls have not been recorded, and the difference is
 * the entire finding.
 */
function renderToolCalls(turn: DebugTurn): HTMLElement {
  const body = el('div', 'ins-tools');

  if (turn.tools.length === 0) {
    body.append(
      el(
        'div',
        'ins-empty',
        turn.outcome === 'open'
          ? 'none yet — the turn is still open'
          : 'none — this answer was not grounded in the world model',
      ),
    );
    return body;
  }

  for (const call of turn.tools) body.append(renderToolCall(call));

  if (turn.toolsDropped > 0) {
    body.append(el('div', 'ins-empty', `${plural(turn.toolsDropped, 'earlier call')} dropped`));
  }
  return body;
}

function renderToolCall(call: DebugToolCall): HTMLElement {
  const row = el('div', 'ins-tool');

  row.append(
    el('span', 'ins-tool-name', call.name),
    el('span', `ins-tool-status ins-tool--${call.status}`, call.status),
    // A pending call keeps its dash rather than borrowing a zero. It is the shape a hung dispatcher
    // takes on this screen, and a hung dispatcher is why the call is recorded before it is made.
    el('span', 'ins-meta', call.durationMs === null ? '—' : formatDuration(call.durationMs)),
    el('span', 'ins-tool-args', call.args),
  );

  // `result` is null only while pending, and a pending call has already said so in its status.
  if (call.result !== null) row.append(el('pre', 'ins-tool-result', call.result));

  return keyed(row, `tool:${String(call.seq)}`);
}

/**
 * The turn's legs, as one line: how long until it asked, how long the asking took, how long until
 * it had finished answering.
 *
 * Each leg is omitted when its endpoint has not happened, rather than being shown as a zero — a
 * turn still speaking and a turn that answered instantly are different things, and only one of them
 * is worth investigating.
 *
 * What is deliberately not here is a leg for the model's own thinking. The gap between the key
 * release and the first call contains a network round trip, the model reading a snapshot and its
 * decision to call at all, and nothing in this process can separate them — so it is labelled for
 * what it is, "to first call", and left un-decomposed.
 */
function formatLegs(turn: DebugTurn): string {
  const legs: string[] = [];

  const first = turn.tools[0];
  if (first !== undefined)
    legs.push(`first call +${formatDuration(Math.max(0, first.at - turn.at))}`);

  const timed = turn.tools.filter((call) => call.durationMs !== null);
  if (timed.length > 0) {
    const total = timed.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
    legs.push(`${plural(timed.length, 'call')} ${formatDuration(total)}`);
  }

  if (turn.closedAt !== null) {
    legs.push(`answered +${formatDuration(Math.max(0, turn.closedAt - turn.at))}`);
  }

  return legs.join(' · ');
}

// -----------------------------------------------------------------------------------------------
// Sources and problems
// -----------------------------------------------------------------------------------------------

export function renderSources(frame: DebugFrame): HTMLElement {
  const body = el('div');
  body.append(
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

  return panel('Sources', null, body);
}

// -----------------------------------------------------------------------------------------------
// Scenarios and the trace (ADR-0039)
// -----------------------------------------------------------------------------------------------

/**
 * The two scenario buttons.
 *
 * Buttons and nothing else, for ADR-0032's reason restated by `scroll.ts`: this document is redrawn
 * whole at 4 Hz, so a click is the only gesture that survives a redraw intact. A row mid-run is
 * disabled and says so — a button that looks clickable while its run is in flight is one somebody
 * presses twice, and main refuses the second press for a reason nobody would see.
 */
export function renderActions(actions: readonly DebugAction[]): HTMLElement {
  const body = el('div');

  if (actions.length === 0) {
    body.append(empty('this inspector can display but not run — no action port is wired'));
    return panel('Scenarios', null, body);
  }

  for (const action of actions) {
    const row = el('div', 'ins-action');

    const button = el('button', 'ins-button', action.running ? `${action.label} …` : action.label);
    button.setAttribute('type', 'button');
    button.dataset.action = action.id;
    button.dataset.focus = `action:${action.id}`;
    if (action.running) button.setAttribute('disabled', '');
    row.append(button);

    if (action.lastOutcome !== null) {
      row.append(pill(action.lastOutcome, action.lastOutcome.startsWith('ok') ? 'good' : 'bad'));
    }
    row.append(el('div', 'ins-action-note', action.note));
    body.append(keyed(row, `action:${action.id}`));
  }

  return panel('Scenarios', 'a run drives the real chain — nothing here fakes a stage', body);
}

/**
 * The coaching chain in order — the one panel that is a sequence.
 *
 * Oldest first, unlike Problems: this is read as a story with an end, and the end is the last line.
 * `sinceRunMs` is shown in preference to an age because "how long after the trigger" is the question
 * a chain that stalls actually poses, and a wall-clock age answers a different one.
 */
export function renderTrace(trace: readonly DebugTraceStep[], now: number): HTMLElement {
  const body = el('div');

  if (trace.length === 0) {
    body.append(empty('nothing traced yet — run a scenario, or wait for a detection'));
    return panel('Trace', null, body);
  }

  for (const step of trace) {
    const row = el('div', 'ins-trace');
    row.append(
      el(
        'span',
        'ins-meta',
        step.sinceRunMs === null
          ? `${formatAge(Math.max(0, now - step.at))} ago`
          : `+${formatDuration(step.sinceRunMs)}`,
      ),
      el('span', `ins-trace-stage ins-stage-${step.stage}`, step.stage),
      el('span', 'ins-trace-message', step.message),
    );
    body.append(keyed(row, `trace:${String(step.seq)}`));
  }

  const clear = el('button', 'ins-button', 'Clear trace');
  clear.setAttribute('type', 'button');
  clear.dataset.clearTrace = 'all';
  clear.dataset.focus = 'trace:clear';
  body.append(clear);

  return panel('Trace', `${plural(trace.length, 'step')}, oldest first`, body);
}

/** `ms` under a second, then seconds to one decimal. A run is seconds; a stage is milliseconds. */
function formatDuration(ms: number): string {
  return ms < 1_000 ? `${String(Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`;
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
      // `at` is main's monotonic clock, so two problems from one origin in the same millisecond
      // would collide. They would also be indistinguishable on screen, which is the only thing the
      // key has to survive.
      body.append(keyed(row, `problem:${String(problem.at)}:${problem.origin}`));
    }
  }
  return panel('Problems', null, body);
}
