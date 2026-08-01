/**
 * What must never leave this machine. Tier 1.
 *
 * Two assertions, both structural rather than incidental:
 *
 * 1. **Chat text.** dota2 §7's ⚠ row is other people's words, and `get_recent_events` is the
 *    command that would otherwise carry them into a third-party API. The gate defaults to off and
 *    this asserts it against a world model that actually contains chat, rather than trusting the
 *    literal in `DEFAULT_PRIVACY` to stay `false`.
 * 2. **`detail` strings.** The failure taxonomy separates what the model is told from what
 *    telemetry is told *by type* precisely so this test has something to assert on (§3.4).
 *
 * §13: "the one that cannot be walked back once it fails in production, and it is cheap."
 */

import { describe, expect, it } from 'vitest';
import type { CallId, MonoMs, RawToolCall, TurnId } from './types.js';
import type { FieldPath, WorldDelta } from '../common/ports.js';
import type { GameClock } from '../common/types.js';
import { ManualClock, createFakeToolPorts, observed } from './testing/index.js';
import { buildToolSurface } from './surface.js';

const CHAT = 'ez mid report shadow fiend';
const PLAYER = 'SomePlayerName';

const raw = (name: string, argumentsJson = '{}', callId = 'c1'): RawToolCall => ({
  callId: callId as CallId,
  turnId: 't1' as TurnId,
  name,
  argumentsJson,
  receivedAt: 0 as MonoMs,
});

function chatHistory(): readonly WorldDelta[] {
  return [
    {
      fromVersion: 1,
      toVersion: 2,
      atGameClock: 600 as GameClock,
      changes: [
        {
          path: 'chat.17.text' as FieldPath,
          before: undefined,
          after: observed(`${PLAYER}: ${CHAT}`),
        },
        {
          path: 'enemies.pudge.level' as FieldPath,
          before: undefined,
          after: observed(12),
        },
      ],
    },
  ];
}

function harness() {
  const clock = new ManualClock();
  const ports = createFakeToolPorts({ clock });
  ports.world.setHistory(chatHistory());
  ports.world.set('self.hero', observed('nevermore'));
  ports.world.set('enemies.pudge.level', observed(12));
  ports.world.set('screen.scoreboard', observed([`${PLAYER}: ${CHAT}`]));
  const surface = buildToolSurface({
    ports,
    env: { visionEnabled: true, readScreenEnabled: true },
  });
  return { ports, surface };
}

describe('egress', () => {
  it('never puts chat text in any command output under the default policy', async () => {
    const { surface } = harness();
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    const calls: RawToolCall[] = [
      raw('get_recent_events', '{}', 'a'),
      raw('get_recent_events', '{"since_seconds":300}', 'b'),
      raw('get_enemy_detail', '{"hero":"pudge"}', 'c'),
      raw('get_timings', '{}', 'd'),
      raw('get_minimap_summary', '{}', 'e'),
    ];

    for (const call of calls) {
      const result = await surface.executor.invoke(call, scope);
      expect(result.output, `${call.name} leaked chat`).not.toContain(CHAT);
      expect(result.output, `${call.name} leaked a player name`).not.toContain(PLAYER);
    }
  });

  it('does emit the same events once the policy allows them, so the test is not vacuous', async () => {
    // A gate that is closed because the path is broken would pass the assertion above for the
    // wrong reason. This is the control.
    const clock = new ManualClock();
    const ports = createFakeToolPorts({ clock });
    ports.world.setHistory(chatHistory());
    const surface = buildToolSurface({
      ports,
      env: { visionEnabled: true, readScreenEnabled: true },
      privacy: { allowChatText: true, allowPlayerNames: true },
    });
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    const result = await surface.executor.invoke(raw('get_recent_events'), scope);
    expect(result.output).toContain(CHAT);
  });

  it('never lets a telemetry `detail` reach the model', async () => {
    const { surface } = harness();
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    // Each of these fails somewhere different in the pipeline, and every `detail` names internals.
    const failures: RawToolCall[] = [
      raw('no_such_tool', '{}', 'a'),
      raw('get_enemy_detail', '{"hero":', 'b'),
      raw('get_enemy_detail', '{"hero":"juggernaut"}', 'c'),
      raw('get_item_info', '{"item":"bkb"}', 'd'),
      raw('get_build_benchmark', '{}', 'e'),
    ];

    for (const call of failures) {
      const result = await surface.executor.invoke(call, scope);
      // Internals: quoted payloads, port names in prose, `fake:` markers from the stub ports.
      expect(result.output, call.name).not.toMatch(
        /fake:|port \w+ is|unexpected property|expected an?/,
      );
      expect(result.output, call.name).not.toContain('undefined');
    }
  });
});
