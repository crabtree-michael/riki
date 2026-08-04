/**
 * ADR-0039's four properties, as the ones a test can hold.
 *
 * The registry is the boundary that keeps "the inspector may run two audited scenarios" from
 * becoming "the inspector may run things", so the assertions worth having are all about refusal:
 * an unregistered id, a second click mid-run, and a seam that is not available right now.
 */

import { describe, expect, it, vi } from 'vitest';

import { createDebugActions, type DebugActionPort, type ScenarioSeam } from './actions.js';

function seam(overrides: Partial<ScenarioSeam> = {}): ScenarioSeam {
  return {
    unavailable: () => null,
    run: () => Promise.resolve(),
    ...overrides,
  };
}

function harness(
  match: ScenarioSeam = seam(),
  speak: ScenarioSeam = seam(),
): {
  actions: DebugActionPort;
  steps: { stage: string; message: string }[];
  runs: (number | null)[];
} {
  const steps: { stage: string; message: string }[] = [];
  const runs: (number | null)[] = [];
  let now = 1_000;

  return {
    steps,
    runs,
    actions: createDebugActions({
      match,
      speak,
      trace: (stage, message) => steps.push({ stage, message }),
      markRun: (startedAt) => runs.push(startedAt),
      now: () => (now += 5),
    }),
  };
}

describe('the registry', () => {
  it('offers exactly the two rows ADR-0039 audited', () => {
    expect(
      harness()
        .actions.list()
        .map((action) => action.id),
    ).toEqual(['scenario.match', 'scenario.speak']);
  });

  it('refuses an id that is not a row, rather than reaching anything', () => {
    const { actions } = harness();
    expect(actions.run('scenario.anything')).toEqual({
      ok: false,
      reason: 'no action named scenario.anything',
    });
  });

  it('refuses a row whose seam says it cannot run, and shows the reason on the row', () => {
    const { actions } = harness(seam(), seam({ unavailable: () => 'no coaching root' }));
    expect(actions.run('scenario.speak')).toEqual({ ok: false, reason: 'no coaching root' });

    const row = actions.list().find((action) => action.id === 'scenario.speak');
    expect(row?.note).toContain('unavailable: no coaching root');
  });

  it('runs nothing on its own — listing is inert', () => {
    const run = vi.fn(() => Promise.resolve());
    harness(seam({ run })).actions.list();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('one run at a time', () => {
  it('refuses a second press while the first is in flight', () => {
    let settle = (): void => undefined;
    const { actions } = harness(
      seam({
        run: () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      }),
    );

    expect(actions.run('scenario.match').ok).toBe(true);
    expect(actions.run('scenario.match')).toEqual({
      ok: false,
      reason: 'scenario.match is already running',
    });
    settle();
  });

  it('marks the row running so the window can disable it', () => {
    const { actions } = harness(seam({ run: () => new Promise<void>(() => undefined) }));
    actions.run('scenario.match');
    expect(actions.list().find((action) => action.id === 'scenario.match')?.running).toBe(true);
  });

  it('frees the row once the run settles, and records how it went', async () => {
    const { actions } = harness();
    actions.run('scenario.match');
    await Promise.resolve();
    await Promise.resolve();

    const row = actions.list().find((action) => action.id === 'scenario.match');
    expect(row?.running).toBe(false);
    expect(row?.lastOutcome).toMatch(/^ok in \d+ ms$/);
  });
});

describe('a failure is reported, never thrown', () => {
  it('catches a seam that rejects, and traces it as a fault', async () => {
    const { actions, steps } = harness(seam({ run: () => Promise.reject(new Error('boom')) }));
    expect(actions.run('scenario.match').ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(steps.some((step) => step.stage === 'fault' && step.message.includes('boom'))).toBe(
      true,
    );
    expect(actions.list().find((action) => action.id === 'scenario.match')?.lastOutcome).toBe(
      'failed: boom',
    );
  });

  it('catches a seam that throws synchronously — main must not die on a click', () => {
    const { actions, steps } = harness(
      seam({
        run: () => {
          throw new Error('sync boom');
        },
      }),
    );

    expect(() => actions.run('scenario.match')).not.toThrow();
    expect(actions.run('scenario.match').ok).toBe(false);
    expect(steps.some((step) => step.stage === 'fault')).toBe(true);
  });
});

describe('the run bracket', () => {
  it('opens on start and closes on settle, so steps carry sinceRunMs only inside a run', async () => {
    const { actions, runs } = harness();
    actions.run('scenario.match');
    await Promise.resolve();
    await Promise.resolve();

    expect(runs).toHaveLength(2);
    expect(runs[0]).toBeTypeOf('number');
    expect(runs[1]).toBeNull();
  });
});
