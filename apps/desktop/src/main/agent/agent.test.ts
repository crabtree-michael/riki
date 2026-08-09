/**
 * A player turn, end to end, with no Electron and no network.
 *
 * A real snapshot renderer, a real world model and a fake session — which is the whole point of the
 * seams: the only thing in this path that needs a process boundary is the one that speaks, and
 * everything up to it is a pure function of a snapshot.
 *
 * Three rules carry the file, and each of them is a thing the deleted coaching agent did the other
 * way round. **The snapshot is rendered on release, not on press**, because the world moves while a
 * question is being asked. **An empty snapshot is still a turn**, because the player asked and
 * silence is indistinguishable from a broken hotkey. **A cancelled gesture renders nothing at all**,
 * because it was not a question.
 */

import { describe, expect, it } from 'vitest';
import type { TurnId } from '@riki/context';
import type { CaptureMode, TurnEndReason } from '@riki/realtime';
import type { FieldPath, HeroId } from '@riki/world-model';
import { fieldPath, heroField } from '@riki/world-model';

import type { AgentTelemetry, SessionTurn, VoiceSessionPort } from './contracts.js';
import { createSnapshotSource, createTurnAgent, toContextReader } from './index.js';
import { buildWorld } from '../testing/world.js';

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const META_CLOCK: FieldPath = fieldPath('meta', 'clock');
const SELF_HERO: FieldPath = fieldPath('self', 'hero');
const SELF_LEVEL: FieldPath = fieldPath('self', 'level');
const SELF_ALIVE: FieldPath = fieldPath('self', 'alive');
const SELF_HEALTH: FieldPath = fieldPath('self', 'health');
const SF = 'sf' as HeroId;

function playedWorld() {
  return buildWorld()
    .put(META_PHASE, 'in_progress')
    .put(META_CLOCK, 600)
    .put(SELF_HERO, 'riki')
    .put(SELF_LEVEL, 11)
    .put(SELF_ALIVE, true)
    .put(SELF_HEALTH, { current: 800, max: 1000 })
    .put(heroField('enemies', SF, 'level'), 12);
}

interface Recorded {
  readonly turnId: TurnId;
  readonly reason: TurnEndReason;
  readonly turn: SessionTurn;
}

class FakeSession implements VoiceSessionPort {
  readonly begun: CaptureMode[] = [];
  readonly ended: Recorded[] = [];
  readonly spoken: SessionTurn[] = [];
  aborts = 0;
  #next = 0;

  speakNow(turn: SessionTurn): Promise<void> {
    this.spoken.push(turn);
    return Promise.resolve();
  }

  beginTurn(mode: CaptureMode): TurnId {
    this.begun.push(mode);
    this.#next += 1;
    return `voice_${String(this.#next)}` as TurnId;
  }

  endTurn(turnId: TurnId, reason: TurnEndReason, turn: SessionTurn): Promise<void> {
    this.ended.push({ turnId, reason, turn });
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.aborts += 1;
    return Promise.resolve();
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

class RecordingTelemetry implements AgentTelemetry {
  readonly turns: { turnId: string; tokens: number }[] = [];
  readonly empties: string[] = [];
  readonly omissions: { turnId: string; omitted: readonly string[] }[] = [];

  playerTurn(turnId: string, snapshotTokens: number): void {
    this.turns.push({ turnId, tokens: snapshotTokens });
  }

  emptySnapshot(turnId: string): void {
    this.empties.push(turnId);
  }

  snapshotOmitted(turnId: string, omitted: readonly string[]): void {
    this.omissions.push({ turnId, omitted });
  }
}

function agentOver(world: ReturnType<typeof buildWorld>, session = new FakeSession()) {
  const telemetry = new RecordingTelemetry();
  const agent = createTurnAgent({
    snapshot: createSnapshotSource({ world: toContextReader(world.reader()) }),
    session,
    clock: { now: () => world.now },
    telemetry,
  });
  return { agent, session, telemetry };
}

describe('a player turn', () => {
  it('opens the session turn on the press and injects the snapshot on the release', async () => {
    const world = playedWorld();
    const { agent, session } = agentOver(world);

    const turnId = agent.beginPlayerTurn('push');
    expect(session.begun).toStrictEqual(['push']);
    // Nothing is rendered yet: the press only has to reach the session inside the overlay's
    // 100 ms budget, and the question has not been asked.
    expect(session.ended).toHaveLength(0);

    await agent.endPlayerTurn(turnId, 'release');
    expect(session.ended).toHaveLength(1);
    expect(session.ended[0]?.turn.snapshotText).toContain('you: riki, lvl 11');
  });

  it('renders the world as it stands at the release, not at the press', async () => {
    // The one timing decision in `index.ts`. A question takes a second or two to ask; answering
    // against the game as it was before the player finished describing it is the failure.
    const world = playedWorld();
    const { agent, session } = agentOver(world);

    const turnId = agent.beginPlayerTurn('push');
    world.put(SELF_HEALTH, { current: 120, max: 1000 }).advance(2);
    await agent.endPlayerTurn(turnId, 'release');

    expect(session.ended[0]?.turn.snapshotText).toContain('12% hp');
    expect(session.ended[0]?.turn.snapshotText).not.toContain('80% hp');
  });

  it('submits a turn even when the world model has nothing in it', async () => {
    // The inversion of coaching-architecture.md §6.5. The player asked; a model that answers "I
    // cannot see the game yet" is telling the truth, and silence looks like a broken hotkey.
    const world = buildWorld({ clock: null });
    const { agent, session, telemetry } = agentOver(world);

    const turnId = agent.beginPlayerTurn('latch');
    await agent.endPlayerTurn(turnId, 'release');

    expect(session.ended).toHaveLength(1);
    expect(session.ended[0]?.turn.snapshotText).toBe('T pre-horn');
    // Not empty, in fact: the header is undroppable. `emptySnapshot` stays unreported.
    expect(telemetry.empties).toStrictEqual([]);
  });

  it('injects nothing for a cancelled gesture, and still tells the session', async () => {
    const world = playedWorld();
    const { agent, session, telemetry } = agentOver(world);

    const turnId = agent.beginPlayerTurn('push');
    await agent.endPlayerTurn(turnId, 'cancel');

    expect(session.ended[0]?.reason).toBe('cancel');
    expect(session.ended[0]?.turn.snapshotText).toBe('');
    // No render happened at all, so nothing is counted against the conversation window.
    expect(telemetry.turns).toStrictEqual([]);
  });
});

describe('telemetry', () => {
  it('reports the turn in tokens and names what the ladder left out', async () => {
    const world = playedWorld();
    const { agent, telemetry } = agentOver(world);

    const turnId = agent.beginPlayerTurn('push');
    await agent.endPlayerTurn(turnId, 'release');

    expect(telemetry.turns).toHaveLength(1);
    expect(telemetry.turns[0]?.tokens).toBeGreaterThan(0);
    // Sections the world model cannot satisfy are absences, and they are recorded as such rather
    // than silently missing from the text.
    expect(telemetry.omissions[0]?.omitted).toContain('map');
  });

  it('carries no rendered text and no player words', () => {
    // dota2 §7: the interface has nowhere to put a transcript, which is what makes that true
    // rather than remembered. Asserted as a shape so a widening of the port fails here.
    const telemetry: AgentTelemetry = new RecordingTelemetry();
    expect(Object.keys(telemetry)).not.toContain('transcript');
    expect(telemetry.playerTurn.length).toBe(2);
  });
});

describe('the id', () => {
  it('comes from the session, so two counters cannot claim the same turn', async () => {
    const world = playedWorld();
    const { agent, session } = agentOver(world);

    const first = agent.beginPlayerTurn('push');
    await agent.endPlayerTurn(first, 'release');
    const second = agent.beginPlayerTurn('push');
    await agent.endPlayerTurn(second, 'release');

    expect(first).not.toBe(second);
    expect(session.ended.map((e) => e.turnId)).toStrictEqual([first, second]);
  });
});
