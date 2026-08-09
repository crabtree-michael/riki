/**
 * The bridge dispatcher — every way a tool call can end, and the one thing none of them may do.
 *
 * A tool call is the only `await` inside a response that is already being spoken (ADR-0049), so
 * "the promise never settles" is not a slow path here, it is a sentence that stops in the middle
 * with no audio and no explanation. Every test below is a way of not settling that this file has to
 * turn into an answer instead.
 *
 * `schedule` is driven by hand: nothing here waits a real millisecond, and a two-second deadline
 * asserted with a real timer would be two seconds of test.
 */

import { describe, expect, it } from 'vitest';

import type { ToolName, VoiceUpdate } from '@riki/protocol';
import { decodeVoiceUpdate, isUnknown } from '@riki/protocol';

import { DEFAULT_TOOL_TIMEOUT_MS, createBridgeToolDispatcher } from './tools.js';

/** The bridge, plus a crank for the deadline and a record of what actually went out. */
function harness() {
  const sent: VoiceUpdate[] = [];
  const rejected: { name: ToolName; callId: string }[] = [];
  const pendingTimers: { delayMs: number; fire: () => void; cancelled: boolean }[] = [];

  const dispatcher = createBridgeToolDispatcher({
    send: (update) => sent.push(update),
    schedule: (delayMs, fire) => {
      const timer = { delayMs, fire, cancelled: false };
      pendingTimers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onTimeout: (name, callId) => rejected.push({ name, callId }),
  });

  // Arrow properties rather than method shorthands: these are destructured at every call site, and
  // `@typescript-eslint/unbound-method` is right that a shorthand pulled off its object is a `this`
  // waiting to be undefined.
  return {
    dispatcher,
    sent,
    rejected,
    /** The `voice.tool.call` most recently put on the bridge, decoded as main would decode it. */
    lastCall: (): Extract<VoiceUpdate, { type: 'voice.tool.call' }> => {
      const raw = sent.at(-1);
      const decoded = decodeVoiceUpdate(raw);
      if (!decoded.ok || decoded.message.type !== 'voice.tool.call') {
        throw new Error(`not a tool call: ${JSON.stringify(raw)}`);
      }
      return decoded.message;
    },
    expire: (): void => {
      for (const timer of pendingTimers) if (!timer.cancelled) timer.fire();
    },
    liveTimers: (): number => pendingTimers.filter((timer) => !timer.cancelled).length,
  };
}

describe('a call main answers', () => {
  it('goes out as a decodable voice.tool.call and comes back as the tool result', async () => {
    const { dispatcher, lastCall } = harness();

    const answer = dispatcher.call('enemy', { hero: 'pudge' });
    const call = lastCall();
    expect(call.name).toBe('enemy');
    expect(call.args).toEqual({ hero: 'pudge' });

    dispatcher.settle(call.callId, { enemies: [] });
    expect(await answer).toEqual({ enemies: [] });
  });

  it('keeps two calls in flight apart', async () => {
    // The whole reason there is a `callId` at all. One counter and one map, so the failure this
    // rules out is the second answer landing on the first call — which the model would read as a
    // confident answer to a question it did not ask.
    const { dispatcher, sent, lastCall } = harness();

    const mine = dispatcher.call('my_state', {});
    const first = lastCall().callId;
    const money = dispatcher.call('economy', {});
    const second = lastCall().callId;

    expect(first).not.toBe(second);
    expect(sent).toHaveLength(2);
    expect(dispatcher.pending).toBe(2);

    dispatcher.settle(second, { my_net_worth: { unknown: 'nobody looked' } });
    dispatcher.settle(first, { hero: { unknown: 'nobody looked' } });

    expect(await mine).toHaveProperty('hero');
    expect(await money).toHaveProperty('my_net_worth');
    expect(dispatcher.pending).toBe(0);
  });

  it('cancels the deadline, so a slow answer is not followed by a timeout', async () => {
    const { dispatcher, lastCall, expire, liveTimers } = harness();

    const answer = dispatcher.call('objectives', {});
    dispatcher.settle(lastCall().callId, { roshan: { unknown: 'nobody looked' } });
    await answer;

    expect(liveTimers()).toBe(0);
    // And firing it anyway changes nothing — a settled call has left the map.
    expire();
    expect(dispatcher.pending).toBe(0);
  });
});

describe('a call main never answers', () => {
  it('answers itself with an unknown rather than hanging the turn', async () => {
    // The failure this file exists for. A directive sent into a wedged main process produces no
    // error of any kind, so without the deadline this promise is a response held open forever.
    const { dispatcher, expire } = harness();

    const answer = dispatcher.call('my_state', {});
    expire();

    const result = await answer;
    expect(isUnknown(result)).toBe(true);
    expect(isUnknown(result) ? result.unknown : '').toContain(String(DEFAULT_TOOL_TIMEOUT_MS));
  });

  it('reports it, because a bridge that silently times out is the state this replaces', async () => {
    // ADR-0049's stated cost: a broken tool layer is quiet. Every call degrades politely and
    // nothing sounds wrong, so the counter is the only evidence anybody gets that it is broken.
    const { dispatcher, rejected, lastCall, expire } = harness();

    const answer = dispatcher.call('economy', {});
    const callId = lastCall().callId;
    expire();
    await answer;

    expect(rejected).toEqual([{ name: 'economy', callId }]);
  });

  it('ignores an answer that arrives after the deadline', async () => {
    const { dispatcher, lastCall, expire } = harness();

    const answer = dispatcher.call('my_state', {});
    const callId = lastCall().callId;
    expire();
    await answer;

    // Main answering late is ordinary — it cannot know our deadline fired — and the model has
    // already been told something true. `false` is how the caller can trace it rather than guess.
    expect(dispatcher.settle(callId, { hero: { unknown: 'late' } })).toBe(false);
    expect(isUnknown(await answer)).toBe(true);
  });

  it('answers everything in flight when the session goes away', async () => {
    // `closeSession` stops the audio. Leaving these to their own deadline would be up to two
    // seconds of a turn nobody is listening to, holding a session teardown open behind it.
    const { dispatcher } = harness();

    const first = dispatcher.call('my_state', {});
    const second = dispatcher.call('economy', {});
    dispatcher.abandon('the voice session closed');

    expect(isUnknown(await first)).toBe(true);
    expect(isUnknown(await second)).toBe(true);
    expect(dispatcher.pending).toBe(0);
  });
});

describe('a result nobody asked for', () => {
  it('is dropped rather than thrown', () => {
    // A `callId` from a session that has been replaced under us — renewal reopens on the same
    // window (ADR-0045), and a throw here would land in an IPC handler in a renderer with no
    // console anyone is watching.
    const { dispatcher } = harness();
    expect(dispatcher.settle('tool_99', { hero: { unknown: 'nobody looked' } })).toBe(false);
  });
});
