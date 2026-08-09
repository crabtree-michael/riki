/**
 * Tier 4: the model asks the world a question, and the answer comes back across the preload
 * boundary — T12.
 *
 * **This is the test whose absence was the bug.** ADR-0042 gave Riki five tools; T3 wrote them, T4
 * wired the dispatch inside `packages/realtime`, T6 added the timeline and T9 built a panel to
 * watch it all. Every one of those has tests and every one of them passed, and in a real match
 * nothing fired at all: the session runs in the voice renderer, the world model runs in main, and
 * there was no message between them — so `deps.tools` was `undefined`, so `tools: []` went out, so
 * the model was never offered a tool. It was found by a player asking why Riki could not see their
 * items, on 2026-08-09, after the whole chain had been signed off green.
 *
 * So this file asserts the seam and only the seam, with **both halves real**:
 *
 * ```
 *   FakeRealtimeTransport ──► createRealtimeSession ──► createBridgeToolDispatcher   (renderer)
 *                                                              │ voice.tool.call
 *                                                     structured clone
 *                                                              ▼
 *          function_call_output ◄── createVoiceSession ◄── createWorldToolDispatcher (main)
 *                                                              │ over a real WorldState
 * ```
 *
 * Nothing between the transport and the world model is a stand-in. The one thing that cannot be
 * real is Electron's IPC, and it is replaced by the guarantee Electron actually gives — a
 * structured clone — written as a JSON round trip so that anything unserialisable fails here rather
 * than in a window. Both decoders run, because a message one side builds and the other cannot read
 * is a call that silently never happens, which is this seam's characteristic failure.
 */

import { describe, expect, it } from 'vitest';

import type { RikiConfig } from '@riki/config';
import { resolveConfig } from '@riki/config';
import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';
import { decodeVoiceDirective, decodeVoiceUpdate, isUnknown, voiceUpdates } from '@riki/protocol';
import type { RealtimeSession, ServerEvent, ToolDispatcher } from '@riki/realtime';
import { ApiKey, createRealtimeSession } from '@riki/realtime';
import type { FakeRealtimeTransport } from '@riki/realtime/testing';
import { createFakeRealtimeTransport } from '@riki/realtime/testing';
import type { FieldPath, HeroId, MonoMs } from '@riki/world-model';
import { fieldPath, heroField } from '@riki/world-model';

import { createWorldToolDispatcher } from '../src/main/agent/index.js';
import { buildWorld, manualClock } from '../src/main/testing/world.js';
import type { VoiceWindow, VoiceWindowFactory } from '../src/main/voice/index.js';
import { createVoiceSession } from '../src/main/voice/index.js';
import { createBridgeToolDispatcher } from '../src/renderer/voice/tools.js';

// Low entropy on purpose — see `session.test.ts` and the `config-secrets` skill.
const KEY = 'sk-test-aaaa-bbbb-cccc-dddd';
const MINTED = { value: 'ek_test_secret_value', expires_at: 0, session: { id: 'sess_1' } };

const META_PHASE: FieldPath = fieldPath('meta', 'phase');
const SELF_HERO: FieldPath = fieldPath('self', 'hero');
const SELF_LEVEL: FieldPath = fieldPath('self', 'level');
const PUDGE = 'pudge' as HeroId;
const NOW = 60_000;

/**
 * The event that starts every real tool call: the model finished emitting arguments on the data
 * channel. `call_id` is branded in `packages/realtime`'s wire types, and the brand is the only
 * reason this is a helper rather than an object literal at each site.
 */
function functionCallDone(callId: string, name: string, args: unknown): ServerEvent {
  return {
    type: 'response.function_call_arguments.done',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  } as ServerEvent;
}

/** What Electron's IPC guarantees, and nothing more: a structured clone, not the same object. */
function cross(message: unknown): unknown {
  return JSON.parse(JSON.stringify(message)) as unknown;
}

/** Macrotasks, not microtasks — the mint, the directive and the renderer's open are several deep. */
async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function config(): RikiConfig {
  return resolveConfig({
    layer: {},
    dataDir: '/tmp/riki',
    gsiToken: 'token',
    apiKey: new ApiKey(KEY),
  });
}

/**
 * A world with a match in it: the player's hero and one observed enemy.
 *
 * Enough for `my_state` and `enemy` to have something real to say, which is the point — an
 * `unknown` from an empty world would pass a round trip that carried nothing across it.
 */
function playing() {
  return buildWorld({ now: NOW, clock: 600 })
    .put(META_PHASE, 'game')
    .put(SELF_HERO, 'riki')
    .put(SELF_LEVEL, 13)
    .put(heroField('enemies', PUDGE, 'level'), 9);
}

interface BothSides {
  readonly toMain: readonly VoiceUpdate[];
  readonly toRenderer: readonly VoiceDirective[];
  /** `session.tools` as it actually went out on the wire, from the fake transport. */
  readonly advertised: readonly { readonly name: string }[];
  readonly transport: FakeRealtimeTransport;
  /** Everything the renderer sent the model, so the `function_call_output` can be read back. */
  outputFor(callId: string): { readonly call_id?: string; readonly output?: string } | undefined;
  close(): Promise<void>;
}

/**
 * Main and the voice renderer, connected by the real messages.
 *
 * `tools: null` builds a main with no dispatcher, which is a supported configuration and the one
 * ADR-0049 says must advertise nothing.
 */
async function bothSides(over: { tools?: ToolDispatcher | null } = {}): Promise<BothSides> {
  const world = playing();
  const worldTools: ToolDispatcher | null =
    over.tools === undefined
      ? createWorldToolDispatcher({
          world: { snapshot: () => world.snapshot() },
          clock: manualClock(NOW),
        })
      : over.tools;

  const toMain: VoiceUpdate[] = [];
  const toRenderer: VoiceDirective[] = [];

  let transport: FakeRealtimeTransport | null = null;
  let realtime: RealtimeSession | null = null;
  let bridgeTools: ReturnType<typeof createBridgeToolDispatcher> | null = null;
  let pushToMain: ((update: VoiceUpdate) => void) | null = null;
  let advertised: readonly { readonly name: string }[] = [];
  let opening: Promise<void> = Promise.resolve();

  /** A function rather than `pushToMain?.(…)` inline: the listener is bound from a callback, and
   * TypeScript's flow analysis would otherwise narrow the variable to `null` at every use site. */
  function push(update: VoiceUpdate): void {
    pushToMain?.(update);
  }

  /** The renderer half of `host.ts`, minus the microphone and the peer connection. */
  async function openRendererSession(
    directive: Extract<VoiceDirective, { type: 'voice.session.open' }>,
  ): Promise<void> {
    const fake = createFakeRealtimeTransport();
    const dispatcher = createBridgeToolDispatcher({
      send: (update) => {
        const decoded = decodeVoiceUpdate(cross(update));
        if (!decoded.ok) throw new Error(`main could not read: ${JSON.stringify(update)}`);
        toMain.push(decoded.message);
        push(decoded.message);
      },
      // Never fires here: nothing in these tests waits, and a live deadline would make every
      // assertion a race between a timer and a promise chain. `tools.test.ts` owns the timeout.
      schedule: () => () => undefined,
      onTimeout: () => undefined,
    });

    realtime = await createRealtimeSession(
      {
        transport: fake,
        credentials: {
          acquire: () =>
            Promise.resolve({
              value: directive.secret.value,
              expiresAt: (NOW + directive.secret.expiresInMs) as never,
              sessionId: directive.secret.sessionId as never,
            }),
        },
        capture: { open: () => undefined, close: () => undefined, isOpen: false },
        playback: { audibleMs: () => 0 },
        clock: { now: () => NOW as never },
        telemetry: {
          turnLatency: () => undefined,
          truncation: () => undefined,
          windowDrop: () => undefined,
          fault: () => undefined,
          cost: () => undefined,
          selfInterruption: () => undefined,
          toolCallRejected: () => undefined,
        },
        // ADR-0049's coupling, honoured exactly as `host.ts` honours it: main said whether it can
        // answer, and that boolean is the only thing that decides whether anything is advertised.
        ...(directive.tools ? { tools: dispatcher } : {}),
      },
      { preambleText: directive.session.instructions },
      directive.session,
    );

    bridgeTools = directive.tools ? dispatcher : null;
    transport = fake;

    const update = fake
      .sent()
      .find((event) => (event as { type?: string }).type === 'session.update');
    advertised =
      (update as { session?: { tools?: readonly { name: string }[] } } | undefined)?.session
        ?.tools ?? [];
  }

  const windows: VoiceWindowFactory = {
    create(): VoiceWindow {
      return {
        send(directive: VoiceDirective): void {
          const decoded = decodeVoiceDirective(cross(directive));
          if (!decoded.ok) {
            throw new Error(`the renderer could not read: ${JSON.stringify(directive)}`);
          }
          toRenderer.push(decoded.message);

          if (decoded.message.type === 'voice.session.open') {
            const open = decoded.message;
            opening = opening.then(() => openRendererSession(open));
            return;
          }
          if (decoded.message.type === 'voice.tool.result') {
            // `host.ts` answers this **off** its directive queue — see `settleToolCall` there.
            bridgeTools?.settle(decoded.message.callId, decoded.message.result);
          }
        },
        onUpdate(listener) {
          pushToMain = listener;
          return () => {
            pushToMain = null;
          };
        },
        onProblem: () => () => undefined,
        close: () => undefined,
      };
    },
  };

  const session = createVoiceSession({
    config: config(),
    windows,
    clock: { now: (): MonoMs => NOW as MonoMs },
    safetyIdentifier: 'install-hash',
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(MINTED)),
      }),
    ...(worldTools === null ? {} : { tools: worldTools }),
  });

  await session.openMatch('You are Riki.');
  // The handshake main queues every directive behind. Without it `voice.session.open` never lands.
  push(voiceUpdates.ready());
  await settle();
  await opening;

  const liveTransport = (): FakeRealtimeTransport => {
    if (transport === null) throw new Error('the renderer never opened a session');
    return transport;
  };

  return {
    toMain,
    toRenderer,
    get advertised(): readonly { readonly name: string }[] {
      return advertised;
    },
    get transport(): FakeRealtimeTransport {
      return liveTransport();
    },
    outputFor: (callId: string) => {
      for (const event of liveTransport().sent()) {
        const item = (event as { item?: { type?: string; call_id?: string; output?: string } })
          .item;
        if (item?.type === 'function_call_output' && item.call_id === callId) return item;
      }
      return undefined;
    },
    close: async (): Promise<void> => {
      await realtime?.close('test over');
    },
  };
}

describe('what a live session advertises', () => {
  it('offers all five tools, which it did not before T12', async () => {
    // The literal regression. Before this ticket every live session's `session.update` carried
    // `tools: []`, and nothing anywhere said so — a session with no tools is indistinguishable
    // from a model that chose not to call one, which is a thing models do.
    const both = await bothSides();
    expect(both.advertised.map((tool) => tool.name).sort()).toEqual([
      'economy',
      'enemy',
      'my_state',
      'objectives',
      'world_at',
    ]);
    await both.close();
  });

  it('offers nothing when main has no dispatcher to answer with', async () => {
    // ADR-0049, end to end and across a process boundary. The decision belongs to whoever holds
    // the dispatcher, that is main, and it travels as `VoiceSessionOpen.tools`.
    const both = await bothSides({ tools: null });
    expect(both.advertised).toEqual([]);
    expect(
      both.toRenderer.find((directive) => directive.type === 'voice.session.open'),
    ).toMatchObject({ tools: false });
    await both.close();
  });
});

describe('a call the model makes', () => {
  it('reaches the world model in main and comes back inside the same turn', async () => {
    const both = await bothSides();

    // Where a real call starts: the model finished emitting arguments on the data channel.
    both.transport.emit(functionCallDone('call_abc', 'enemy', { hero: 'pudge' }));
    await settle();

    // It crossed, and it decoded on the far side.
    expect(both.toMain.find((update) => update.type === 'voice.tool.call')).toMatchObject({
      name: 'enemy',
      args: { hero: 'pudge' },
    });

    // Main answered from a real `WorldState` — not an `unknown`, which is what every one of the
    // failure paths would have produced and what makes this the assertion that means anything.
    const answered = both.toRenderer.find((directive) => directive.type === 'voice.tool.result');
    expect(answered).toBeDefined();
    expect(isUnknown(answered?.type === 'voice.tool.result' ? answered.result : {})).toBe(false);

    // And the model was told, in the shape it reads, addressed to the call it made.
    const output = both.outputFor('call_abc');
    expect(output).toBeDefined();
    expect(JSON.parse(output?.output ?? '{}')).toMatchObject({ enemies: [{ hero: 'pudge' }] });

    await both.close();
  });

  it('answers a tool that throws with an unknown, not with a turn that stops', async () => {
    // ADR-0049. A throw in main is the one failure that could take the audio with it: the output
    // item still goes out, carrying a sentence the model can say.
    const both = await bothSides({
      tools: {
        call: () => Promise.reject(new Error('the world model exploded')),
      },
    });

    both.transport.emit(functionCallDone('call_boom', 'my_state', {}));
    await settle();

    const output = both.outputFor('call_boom');
    expect(output).toBeDefined();
    expect((JSON.parse(output?.output ?? '{}') as { unknown?: string }).unknown).toContain(
      'the world model exploded',
    );

    await both.close();
  });
});
