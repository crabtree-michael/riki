/**
 * The snapshot decorator, and the property that makes it safe to leave on.
 *
 * ADR-0032's rule is that the inspector observes by decoration and changes nothing. For this seam
 * that reduces to one assertion worth making mechanically rather than by reading: **the wrapped
 * source returns the delegate's own object**, so the agent that renders through it and the golden
 * corpus that renders around it cannot disagree about what a turn was given.
 *
 * The previous version of this file wrapped `RikiContext` and spent most of its length checking
 * that a spread-and-override copy carried every member of a real `ContextAssembler` across.
 * ADR-0042 deleted the assembler; a `SnapshotSource` has one method, so that whole class of
 * failure is gone with it.
 */

import { describe, expect, it } from 'vitest';

import type { TurnId } from '@riki/context';
import type { FieldPath, MonoMs } from '@riki/world-model';

import type { SnapshotSource } from '../agent/index.js';
import { createSnapshotSource, toContextReader } from '../agent/index.js';
import { buildWorld } from '../testing/world.js';
import type { DebugTurnOpenedInput } from './contracts.js';
import { observeSnapshots } from './observing-snapshot.js';

function realSource(): SnapshotSource {
  const world = buildWorld({ now: 1_000, clock: 600 })
    .put('meta.phase' as FieldPath, 'in_progress')
    .put('self.hero' as FieldPath, 'riki')
    .put('self.level' as FieldPath, 9);

  return createSnapshotSource({ world: toContextReader(world.reader()) });
}

interface Recorded {
  readonly rendered: DebugTurnOpenedInput[];
  readonly wrapped: SnapshotSource;
}

function wrap(delegate: SnapshotSource, cause = 'player'): Recorded {
  const rendered: DebugTurnOpenedInput[] = [];
  const wrapped = observeSnapshots({
    delegate,
    clock: () => 600,
    cause: () => cause,
    onRendered: (turn) => rendered.push(turn),
  });
  return { rendered, wrapped };
}

// -------------------------------------------------------------------------------------------

describe('the wrap is faithful', () => {
  it('returns the delegate own snapshot, not a reconstruction of it', () => {
    const delegate = realSource();
    const { wrapped } = wrap(delegate);

    const direct = delegate.render('turn_1' as TurnId, 1_000 as MonoMs);
    const observed = wrapped.render('turn_1' as TurnId, 1_000 as MonoMs);

    expect(observed.text).toBe(direct.text);
    expect(observed.tokens).toBe(direct.tokens);
    expect(observed.turnId).toBe(direct.turnId);
  });

  it('renders once per call, so the inspector cannot double the per-turn cost', () => {
    let calls = 0;
    const counting: SnapshotSource = {
      render: (turnId, now) => {
        calls += 1;
        return realSource().render(turnId, now);
      },
    };
    const { wrapped } = wrap(counting);

    wrapped.render('turn_1' as TurnId, 1_000 as MonoMs);
    expect(calls).toBe(1);
  });
});

describe('what it reports', () => {
  it('reports the rendered snapshot, its size and what was left out', () => {
    const { rendered, wrapped } = wrap(realSource());

    wrapped.render('turn_1' as TurnId, 1_000 as MonoMs);

    const [turn] = rendered;
    expect(turn?.turnId).toBe('turn_1');
    expect(turn?.cause).toBe('player');
    expect(turn?.clock).toBe(600);
    expect(turn?.snapshotText.length).toBeGreaterThan(0);
    expect(turn?.snapshotTokens).toBeGreaterThan(0);
    // A section the world model cannot satisfy is an omission, not an absence — the panel should
    // show which lines the model did not get, whichever reason it was.
    expect(turn?.snapshotOmitted).toContain('map');
  });

  it('carries the cause it was given, so a scenario is not shown as a question', () => {
    // `scenario.speak` renders through the same source (ADR-0039). Presenting a button press in the
    // Turns panel as something the player asked would make the one window built to be believed lie.
    const { rendered, wrapped } = wrap(realSource(), 'system');
    wrapped.render('scenario_1' as TurnId, 1_000 as MonoMs);
    expect(rendered[0]?.cause).toBe('system');
  });
});
