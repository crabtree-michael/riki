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
 * **`textContent`, never `innerHTML`.** Everything on this screen came from a Dota client, a
 * detector's phrasing, or a rendered brief — none of it is ours, and the document's CSP would stop
 * a script running but not a layout being wrecked by a stray angle bracket in a hero name.
 *
 * **Nothing is inferred.** Where the frame says a value is null, the panel says so rather than
 * showing a plausible zero: "never observed" and "observed to be zero" are different claims, and
 * `packages/world-model` goes to some trouble to keep them apart. Undoing that in the one view
 * built to inspect it would be the worst place to undo it.
 *
 * **Anything repeated carries a `data-ins-key`.** A tick, a turn, a fact, a row — each is stamped
 * with an identity that survives the next frame, which is the whole of what `scroll.ts` needs to
 * put the reader back where they were after the document is rebuilt underneath them. The key is
 * derived from the frame (a `seq`, a `turnId`, a fact path), never from render order, because
 * render order is exactly what a new tick changes.
 */

import type {
  DebugAction,
  DebugCandidate,
  DebugControl,
  DebugControlValue,
  DebugCount,
  DebugFrame,
  DebugGateState,
  DebugMockState,
  DebugProblem,
  DebugTick,
  DebugTraceStep,
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
  /**
   * Which Controls groups are expanded.
   *
   * Sixty-odd settings is a scrollable column on its own, and all but two groups are things you go
   * looking for rather than watch. Which are open is view state and lives in `app.ts` for the same
   * reason `frozen` does: the document is rebuilt whole on every frame, so anything the DOM would
   * normally remember has to be held outside it.
   */
  readonly openGroups: readonly string[];
  /**
   * Which mock game state a rehearsal would run against, or null to mean *the first one offered*.
   *
   * Null rather than an eager copy of `mocks[0].id`, because the library is a directory read four
   * times a second: a default resolved here would be a guess about a list this file has not been
   * handed yet, and one resolved once at mount would be wrong the moment somebody drops a fixture
   * in. `renderRehearsal` resolves it against the list in the frame it is rendering.
   */
  readonly selectedMock: string | null;
  /** Whether the mock-state dropdown is expanded. View state, for the reason `openGroups` is. */
  readonly mockOpen: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  hideNotInMatch: true,
  openGroups: ['Coach', 'Thresholds'],
  selectedMock: null,
  mockOpen: false,
};

/**
 * The order the Controls groups are drawn in, which is roughly how often they are wanted.
 *
 * A group the registry adds and this list does not name still renders — sorted after these, by
 * name. A hard-coded list that silently dropped a group would defeat the point of making the
 * registry self-describing.
 */
const GROUP_ORDER: readonly string[] = [
  'Coach',
  'Thresholds',
  'Cooldowns',
  'Gates',
  'Detectors',
  'Kind weights',
  'Kind cooldowns',
  'Detector thresholds',
  'Intensity',
  'Reference data',
];

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

  // At the top, in the loudest tone the stylesheet has, because everything below it is then a
  // reading of a tuned app rather than of the shipped one. The realistic failure this window
  // introduced is somebody moving `speakThreshold` to 0.05, forgetting, and reporting that Riki
  // will not stop talking.
  const overridden = frame.controls.filter((control) => control.overridden).length;
  if (overridden > 0) head.append(pill(plural(overridden, 'override'), 'bad'));
  if (world.paused) head.append(pill('paused', 'on'));
  if (session.muted) head.append(pill('muted', 'on'));
  if (session.chipVisible) head.append(pill('chip visible', 'off'));

  return head;
}

// -----------------------------------------------------------------------------------------------
// Controls — the one panel that writes (ADR-0037)
// -----------------------------------------------------------------------------------------------

/**
 * Every element that does something carries `data-control`, and nothing here has a listener.
 *
 * The panel is the only interactive surface in a document that is rebuilt whole four times a
 * second, so per-node listeners would be attached and thrown away at 4 Hz for as long as the window
 * is open. `app.ts` puts one delegated listener on the root instead and reads these attributes,
 * which also keeps this file what its header says it is: pure, total, and testable by asserting on
 * a returned element rather than by driving a bridge.
 *
 * `data-focus` is the other half. A click inside a panel that is about to be replaced loses the
 * focus ring, and a keyboard user tabbing to `speakThreshold`'s `+` would be returned to the top of
 * the document 250 ms later. `app.ts` reads the key back after every draw and restores it.
 */
function action(
  control: DebugControl,
  value: DebugControlValue,
  text: string,
  className: string,
  focusSuffix: string,
): HTMLElement {
  const button = el('button', className, text);
  button.setAttribute('type', 'button');
  button.dataset.control = control.id;
  button.dataset.kind = control.kind;
  button.dataset.value = String(value);
  button.dataset.focus = `${control.id}:${focusSuffix}`;
  return button;
}

/** Integers plainly; everything else to three decimals with the trailing zeros taken off. */
export function formatControlNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatControlValue(value: DebugControlValue, unit: string | null): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const text = typeof value === 'number' ? formatControlNumber(value) : value;
  return unit === null ? text : `${text} ${unit}`;
}

function controlWidget(control: DebugControl): HTMLElement {
  const wrap = el('span', 'ins-value ins-control-value');

  // Locked controls are rendered, not hidden. "Why can I not turn off the muted gate" is a question
  // the window should answer where it is asked; a control that is simply absent invites somebody to
  // add it, which is the outcome `LOCKED_GATES` exists to prevent.
  if (control.locked !== null) {
    wrap.append(el('span', 'ins-control-locked', formatControlValue(control.value, control.unit)));
    wrap.append(pill('locked', 'off'));
    return wrap;
  }

  if (control.kind === 'boolean') {
    const on = control.value === true;
    const button = action(
      control,
      !on,
      on ? 'on' : 'off',
      `ins-switch ins-switch--${on ? 'on' : 'off'}`,
      'toggle',
    );
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(on));
    wrap.append(button);
    return wrap;
  }

  if (control.kind === 'enum') {
    for (const option of control.options) {
      const chosen = option === control.value;
      const button = action(
        control,
        option,
        option,
        chosen ? 'ins-choice ins-choice--on' : 'ins-choice',
        option,
      );
      button.setAttribute('aria-pressed', String(chosen));
      wrap.append(button);
    }
    return wrap;
  }

  // A stepper rather than a text field, and that is a consequence of the redraw rather than a
  // preference: an `<input>` being typed into would have its value replaced four times a second.
  // A click is atomic, so it cannot be interrupted by a frame.
  const value = typeof control.value === 'number' ? control.value : 0;
  const step = control.step ?? 1;
  const min = control.min;
  const max = control.max;

  const down = action(control, value - step, '−', 'ins-step', 'down');
  down.setAttribute('aria-label', `${control.label} down`);
  if (min !== null && value <= min) down.setAttribute('disabled', '');

  const up = action(control, value + step, '+', 'ins-step', 'up');
  up.setAttribute('aria-label', `${control.label} up`);
  if (max !== null && value >= max) up.setAttribute('disabled', '');

  wrap.append(down, el('span', 'ins-control-number', formatControlValue(value, control.unit)), up);
  return wrap;
}

function renderControlRow(control: DebugControl, noteShownAbove: boolean): HTMLElement {
  const row = el('div', control.overridden ? 'ins-control ins-control--set' : 'ins-control');

  const label = el('span', 'ins-key', control.label);
  row.append(label, controlWidget(control));

  const meta = el('span', 'ins-meta');
  meta.textContent = [
    // Only when it differs, and always as "config": the value the app would use on its own is the
    // thing a reading has to be interpreted against, and it is what Reset restores.
    control.overridden ? `config ${formatControlValue(control.base, control.unit)}` : '',
    control.locked ?? (noteShownAbove ? '' : (control.note ?? '')),
  ]
    .filter((part) => part !== '')
    .join(' · ');
  // Clipped to one line by the stylesheet — sixty four-line rows is a panel nobody reads to the
  // bottom of — so the full text goes on the row as a tooltip rather than being lost.
  if (meta.textContent !== '') row.setAttribute('title', meta.textContent);
  row.append(meta);

  if (control.overridden) {
    const undo = action(control, control.base, '↺', 'ins-step ins-step--undo', 'reset');
    undo.setAttribute('aria-label', `reset ${control.label}`);
    row.append(undo);
  }

  return keyed(row, `control:${control.id}`);
}

/**
 * The note every member of a group shares, or null when they do not share one.
 *
 * The thirteen gates all carry the same sentence — *off means the gate is still evaluated and
 * displayed, and no longer refuses* — because it is a property of the control kind rather than of
 * any one gate, and thirteen copies of it is a wall. Shown once under the group header instead.
 */
function sharedNote(members: readonly DebugControl[]): string | null {
  const first = members[0]?.note ?? null;
  if (first === null || members.length < 2) return null;
  return members.every((control) => control.note === first) ? first : null;
}

/** Named groups first in `GROUP_ORDER`, then anything the registry added, alphabetically. */
function orderGroups(names: Iterable<string>): readonly string[] {
  return [...names].sort((a, b) => {
    const left = GROUP_ORDER.indexOf(a);
    const right = GROUP_ORDER.indexOf(b);
    if (left === right) return a < b ? -1 : a > b ? 1 : 0;
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  });
}

export function renderControls(
  controls: readonly DebugControl[],
  options: ViewOptions,
): HTMLElement {
  const body = el('div');

  if (controls.length === 0) {
    // The shape a headless replay runs in: frames are collected, and there is no control port
    // behind them. Saying so is the difference between that and a panel that failed to render.
    body.append(empty('this inspector can display but not change — no control port is wired'));
    return panel('Controls', null, body);
  }

  const groups = new Map<string, DebugControl[]>();
  for (const control of controls) {
    const bucket = groups.get(control.group);
    if (bucket === undefined) groups.set(control.group, [control]);
    else bucket.push(control);
  }

  for (const name of orderGroups(groups.keys())) {
    const members = groups.get(name) ?? [];
    const open = options.openGroups.includes(name);
    const changed = members.filter((control) => control.overridden).length;

    const header = el('button', 'ins-group', `${open ? '▾' : '▸'} ${name}`);
    header.setAttribute('type', 'button');
    header.setAttribute('aria-expanded', String(open));
    header.dataset.group = name;
    header.dataset.focus = `group:${name}`;
    if (changed > 0) header.append(pill(String(changed), 'bad'));
    // Keyed for `scroll.ts` as well as for focus: expanding a group inserts rows above everything
    // below it, which is the prepend case the anchor exists for.
    body.append(keyed(header, `group:${name}`));

    if (!open) continue;

    const shared = sharedNote(members);
    if (shared !== null) body.append(el('div', 'ins-group-note', shared));
    for (const control of members) body.append(renderControlRow(control, shared !== null));
  }

  const overridden = controls.filter((control) => control.overridden).length;

  const reset = el('button', 'ins-button', 'Reset all');
  reset.setAttribute('type', 'button');
  reset.dataset.reset = 'all';
  reset.dataset.focus = 'reset:all';
  if (overridden === 0) reset.setAttribute('disabled', '');
  body.append(reset);

  // The two facts somebody reading this panel three hours into a session needs: how far it is from
  // the config, and that none of it will still be there tomorrow.
  const note =
    overridden === 0
      ? 'session only — nothing here is written to settings.json'
      : `${plural(overridden, 'override')} · session only, except the coach`;

  return panel('Controls', note, body);
}

// -----------------------------------------------------------------------------------------------
// Rehearsal — the one panel that *acts* (ADR-0038)
// -----------------------------------------------------------------------------------------------

/**
 * Which state a rehearsal would run against: the reader's choice, or the first one offered.
 *
 * Exported because `app.ts` needs the same answer this panel drew — a selection that resolved to a
 * default here and to `null` there would be a button whose label and effect disagreed. It reads it
 * off the button's `data-rehearse` instead, and this is the function that puts it there.
 */
export function selectedMockOf(
  mocks: readonly DebugMockState[],
  options: ViewOptions,
): DebugMockState | null {
  const chosen = mocks.find((mock) => mock.id === options.selectedMock);
  // Falling back rather than holding a selection that is no longer on offer: the library is re-read
  // every frame, so a fixture can be renamed or deleted while the window is open, and a dropdown
  // still naming it would rehearse nothing and say only that it could not find it.
  return chosen ?? mocks[0] ?? null;
}

/**
 * Pick a game state, run one coach turn against it, read the answer in Coach turns.
 *
 * **Why this is a disclosure and not a `<select>`.** The document is rebuilt four times a second, so
 * a native dropdown would be destroyed while its list was open — the same fact that makes every
 * control on this screen a button (ADR-0037). A `<select>` also carries a popup this renderer cannot
 * see or restore. So the list is buttons and its expansion is view state in `app.ts`, which is the
 * one shape that survives a redraw and the one the Controls groups already use.
 *
 * The panel is deliberately first in the column. It is the only thing here that *does* something,
 * and the turn it produces lands two columns over — so having to scroll past sixty settings to
 * reach the button would be the whole feature's cost paid on every use.
 */
export function renderRehearsal(
  mocks: readonly DebugMockState[],
  options: ViewOptions,
): HTMLElement {
  const body = el('div');

  if (mocks.length === 0) {
    // Said as an instruction rather than an absence: an empty `fixtures/gsi/` and a packaged build
    // with no fixtures at all are the same picture, and one of them is fixed by adding a file.
    body.append(
      empty('no mock game states — add a .jsonl to fixtures/gsi/ and it appears here, no restart'),
    );
    return panel('Rehearsal', null, body);
  }

  const selected = selectedMockOf(mocks, options);

  const selectedLabel = selected === null ? 'none' : selected.label;
  const toggle = el('button', 'ins-group', `${options.mockOpen ? '▾' : '▸'} ${selectedLabel}`);
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-expanded', String(options.mockOpen));
  toggle.setAttribute('aria-label', `game state: ${selectedLabel}`);
  toggle.dataset.mockToggle = 'toggle';
  toggle.dataset.focus = 'mock:toggle';
  if (selected !== null) toggle.append(pill(plural(selected.observations, 'observation'), 'off'));
  body.append(keyed(toggle, 'mock:toggle'));

  if (options.mockOpen) {
    for (const mock of mocks) {
      const chosen = mock.id === selected?.id;
      const row = el('div', 'ins-mock-option');

      const option = el('button', chosen ? 'ins-choice ins-choice--on' : 'ins-choice', mock.label);
      option.setAttribute('type', 'button');
      option.setAttribute('aria-pressed', String(chosen));
      option.dataset.mock = mock.id;
      option.dataset.focus = `mock:${mock.id}`;
      row.append(option, el('span', 'ins-meta', plural(mock.observations, 'observation')));

      // The recording's own header, which is where `fixtures/gsi/` says whether somebody captured
      // the state or made it up — the one fact worth having beside a scenario name when you are
      // deciding what a rehearsal against it proves. On the row, clipped to one line, for the
      // reason a control's note is: a column this narrow turns every sentence into four lines.
      if (mock.note !== null) row.setAttribute('title', mock.note);

      body.append(keyed(row, `mock:${mock.id}`));
    }
  }

  const run = el('button', 'ins-button ins-button--go', 'Rehearse a coach turn');
  run.setAttribute('type', 'button');
  run.dataset.focus = 'rehearse';
  if (selected === null) run.setAttribute('disabled', '');
  else run.dataset.rehearse = selected.id;

  const runRow = el('div', 'ins-mock-run');
  runRow.append(run);
  body.append(keyed(runRow, 'mock:run'));

  // What the button does and, more usefully, what it cannot do. A window that can make the app act
  // has to say where the effect goes and where it stops.
  const note =
    'one turn, against a scratch world — nothing is spoken and the live match is untouched';

  return panel('Rehearsal', note, body);
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
  body.append(keyed(row, 'row:switches'));

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
  // `seq` is the hub's own counter and never repeats within a session, which is what lets a reader
  // stay on one tick while several more are prepended above it.
  return keyed(wrap, `tick:${String(tick.seq)}`);
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
  if (turn.mockState !== null) {
    // The load-bearing pill on this screen. A rehearsed turn renders exactly like a real one and
    // lands in the same buffer, so without this the panel would offer a fabricated moment and a
    // played one as the same claim — which is the one thing this window must never do (ADR-0038).
    head.append(pill(`mock: ${turn.mockState}`, 'on'));
  }
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

  if (turn.guidance !== null) {
    // The coach's output, which is a different claim from `riki said` below it: this is the line the
    // LLM coach drafted, before any voice model saw it. On a rehearsal nothing speaks, so this is
    // the whole of the answer — and it is the reason the Coach turns panel is where a rehearsal is
    // read rather than somewhere new (ADR-0038).
    wrap.append(
      el('div', 'ins-text-label', 'coach drafted'),
      el('pre', 'ins-text ins-text--guidance', turn.guidance),
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

  return keyed(wrap, `turn:${turn.turnId}`);
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
