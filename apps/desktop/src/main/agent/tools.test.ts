/**
 * The dispatch table, and the two things only it can get wrong.
 *
 * `packages/world-model` already tests what each of the five tools *says* — that is
 * `tools/tools.test.ts` and `timeline/timeline.test.ts`, and repeating any of it here would be
 * testing T3 again, badly. What is this file's is everything between a tool *name* and one of those
 * functions: that each name reaches the right one, that the arguments survive, that a live tool and
 * a historical one read different things, and that the ways this layer can have nothing to answer
 * with come back as sentences rather than as exceptions.
 *
 * The results are parsed against `TOOLS[name].result` rather than inspected as `Record`s, for the
 * reason the `testing` skill records: a hand-written expected shape agrees with a wrong projection,
 * and zod's inferred type does not.
 */

import { describe, expect, it } from 'vitest';

import type { ToolResultFor } from '@riki/protocol';
import { TOOLS, isUnknown } from '@riki/protocol';
import type { FieldPath, HeroId } from '@riki/world-model';
import { createMatchRecorder, fieldPath, heroField } from '@riki/world-model';

import { buildWorld, manualClock } from '../testing/world.js';
import { createWorldToolDispatcher } from './tools.js';

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const SELF_HERO: FieldPath = fieldPath('self', 'hero');
const SELF_LEVEL: FieldPath = fieldPath('self', 'level');
const SELF_GOLD: FieldPath = fieldPath('self', 'gold');
const PUDGE = 'pudge' as HeroId;

/** A live world with a match in progress — without the phase, every tool answers "no match". */
function playing() {
  return buildWorld({ now: 60_000, clock: 600 })
    .put(META_PHASE, 'game')
    .put(SELF_HERO, 'riki')
    .put(SELF_LEVEL, 11)
    .put(SELF_GOLD, { reliable: 300, unreliable: 1_520 });
}

function dispatcherOver(
  world: ReturnType<typeof playing>,
  recording?: () => Promise<string | null>,
) {
  return createWorldToolDispatcher({
    world: { snapshot: () => world.snapshot() },
    clock: manualClock(world.now),
    ...(recording === undefined ? {} : { recording }),
  });
}

/** zod's own inferred type, so a projection that drifts stops the *test* compiling. */
function known<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  return schema.parse(value);
}

describe('the four live tools', () => {
  it('routes each name to the projection that answers it', async () => {
    const tools = dispatcherOver(playing());

    const mine = known(TOOLS.my_state.result, await tools.call('my_state', {}));
    expect(isUnknown(mine)).toBe(false);
    // The field is the point: `my_state` and `economy` both read gold and only one reports a level.
    expect(isUnknown(mine) ? null : mine.level).toMatchObject({ value: 11, source: 'gsi' });

    const money = known(TOOLS.economy.result, await tools.call('economy', {}));
    expect(isUnknown(money)).toBe(false);

    const objectives = known(TOOLS.objectives.result, await tools.call('objectives', {}));
    // Nobody has looked at Roshan, which is an answer and not a failure (ADR-0043).
    expect(objectives).toBeDefined();
  });

  it('carries a tool argument through to the tool', async () => {
    // The dispatcher's own failure mode: calling `enemy()` with the arguments dropped answers for
    // everyone (ADR-0046), which is a plausible-looking result for a question about one hero.
    const world = playing().put(heroField('enemies', PUDGE, 'level'), 9);
    const tools = dispatcherOver(world);

    const asked = known(TOOLS.enemy.result, await tools.call('enemy', { hero: 'pudge' }));
    expect(isUnknown(asked) ? [] : asked.enemies.map((e) => e.hero)).toEqual(['pudge']);

    const missing = known(TOOLS.enemy.result, await tools.call('enemy', { hero: 'lion' }));
    expect(isUnknown(missing)).toBe(true);
  });

  it('reads the world at the moment of the call, not at the moment it was wired', async () => {
    // A dispatcher that captured a snapshot at construction would pass every assertion above and
    // would answer a whole match from the state it was built in.
    const world = playing();
    const tools = dispatcherOver(world);

    await tools.call('my_state', {});
    world.put(SELF_LEVEL, 17);

    const later = known(TOOLS.my_state.result, await tools.call('my_state', {}));
    expect(isUnknown(later) ? null : later.level).toMatchObject({ value: 17 });
  });
});

describe('world_at', () => {
  it('says there is no past to look at rather than throwing', async () => {
    // Between matches, and on a `buildStateSubsystem` with no `recording` option. Both are real
    // configurations, and a rejected promise here lands in a sentence that is already being spoken.
    const withNoPort = dispatcherOver(playing());
    const answer = await withNoPort.call('world_at', { seconds_ago: 30 });
    expect(isUnknown(answer) ? answer.unknown : '').toContain('no match is being recorded');

    const withEmptyFile = dispatcherOver(playing(), () => Promise.resolve(''));
    expect(isUnknown(await withEmptyFile.call('world_at', { seconds_ago: 30 }))).toBe(true);
  });

  it('re-reads the recording on every call', async () => {
    // `TimelineTarget.secondsAgo` is measured from the last line the timeline holds, so a timeline
    // opened once and kept answers about the match's opening minutes forever — while sounding
    // entirely current. Counting the reads is the only way to see that from outside.
    let reads = 0;
    const tools = dispatcherOver(playing(), () => {
      reads += 1;
      return Promise.resolve('');
    });

    await tools.call('world_at', { seconds_ago: 5 });
    await tools.call('world_at', { seconds_ago: 5 });
    expect(reads).toBe(2);
  });

  it('does not read the recording for a live tool', async () => {
    let reads = 0;
    const tools = dispatcherOver(playing(), () => {
      reads += 1;
      return Promise.resolve('');
    });

    await tools.call('my_state', {});
    expect(reads).toBe(0);
  });

  it('answers a reconstructed instant from a recording', async () => {
    // The join, end to end: a recording produced by the real recorder, read back through the real
    // timeline, projected by the same four functions the live tools are. The recording is built by
    // the world model's own writer, so nothing here hand-writes a line format.
    const contents = recordedMatch();
    const tools = dispatcherOver(playing(), () => Promise.resolve(contents));

    const answer: ToolResultFor<'world_at'> = known(
      TOOLS.world_at.result,
      await tools.call('world_at', { seconds_ago: 0, topic: 'my_state' }),
    );
    expect(isUnknown(answer)).toBe(false);
    expect(isUnknown(answer) ? null : answer.at_clock).toBe('10:00');
  });
});

/**
 * One match, recorded exactly as the app records one.
 *
 * `createMatchRecorder` over an in-memory sink rather than a hand-written JSONL string: the format
 * is `record/format.ts`'s and a fixture written here would be this file's opinion of it.
 */
function recordedMatch(): string {
  const lines: string[] = [];
  const world = playing();
  const recorder = createMatchRecorder({
    openSink: () => ({ writeLine: (line) => lines.push(line), close: () => undefined }),
    world: world.reader(),
  });

  recorder.open('7777777', world.now);
  recorder.keyframe(world.now, 'test');
  recorder.close(world.now, 'match_ended');
  return `${lines.join('\n')}\n`;
}
