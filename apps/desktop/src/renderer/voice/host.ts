/**
 * The voice window's whole behaviour: directives in, `VoiceEvent`s out.
 *
 * This is the renderer half of voice-input-architecture.md §7.3. The other half is
 * `apps/desktop/src/main/voice/`, and between them they are the only place where `@riki/audio`,
 * `@riki/realtime` and `@riki/protocol` appear together.
 *
 * Everything DOM-shaped arrives through `VoiceMediaPorts` and `VoiceBridgePort`, so the file you
 * are reading has no microphone, no `AudioContext` and no peer connection in it — which is what
 * makes `host.test.ts` a Tier 1 test. The three adapters that *do* name those APIs are
 * `web-audio.ts`, `media.ts` and `peer.ts`, and each is small enough to read in one sitting,
 * because everything worth asserting was moved here.
 *
 * ## The four things this file is actually responsible for
 *
 * 1. **Ordering.** A session cannot open before the microphone does, and the transport cannot
 *    connect before the graph exists to give it a track. A directive that arrives mid-open is
 *    queued rather than raced (`pending`).
 * 2. **Turning a rejection into a `VoiceEvent`.** A denied microphone, a stale secret and a
 *    refused SDP exchange are three completely different failures that must all reach the chip as
 *    one `fault`. Nothing here throws to the bridge: a throw in an IPC handler in a renderer with
 *    no console is the failure mode this whole area is trying to avoid.
 * 3. **Merging two event streams.** The session emits turn, transcript, command, cost and fault;
 *    the capture graph emits level and speech; the playback tracker emits output level. §2.2 says
 *    the composition root merges them because it is the only thing holding both objects — this is
 *    that root's renderer half.
 * 4. **Not sending level frames nobody is looking at.** Overlay §5.5: 30 Hz while the chip can
 *    show bars, and *nothing* otherwise. `voice.level.enable` is the switch.
 * 5. **Giving the session something that can answer a tool call.** The five tools read a
 *    `WorldState`, which only main may hold, so the dispatcher injected here is a request across
 *    the bridge (`tools.ts`). Whether one is built at all is main's answer, on
 *    `VoiceSessionOpen.tools` — ADR-0049 ties the manifest to the dispatcher, and the dispatcher
 *    is on the other side.
 *
 * ## The one message that must not be queued
 *
 * `voice.tool.result` bypasses `queue`, unlike every other directive. It is the reply to a request
 * this file made from inside an `await` that an earlier handler may still be in, so serialising it
 * behind that handler is a deadlock with no error on either side. `settleToolCall` is the whole of
 * it, and `start()` is where the interception lives.
 *
 * ## One telemetry signal dies at this bridge, and it is worth naming
 *
 * `VoiceTelemetry.selfInterruption` fires when the server reports speech while our gate is shut —
 * the model hearing itself, which is the AEC failure ADR-0001 chose Electron to avoid. There is no
 * protocol message for it, so it is counted here and goes no further. It belongs in the next
 * change to `schemas/voice.ts`; until then, a suspected echo loop has to be diagnosed from the
 * `capture` and `turn` events rather than from the counter that exists for it.
 */

import type {
  AudioFault,
  CaptureGraph,
  DeviceId,
  DeviceRegistry,
  MicStream,
  PlaybackTracker,
  RemoteTrack,
} from '@riki/audio';
import { createCaptureGraph, createPlaybackTracker } from '@riki/audio';
import type {
  ClientSecret as RealtimeClientSecret,
  MonoMs,
  RealtimeSession,
  SessionId,
  TurnId,
  VoiceEvent,
  VoiceFault,
  VoiceTelemetry,
} from '@riki/realtime';
import {
  createRealtimeSession,
  createWebRtcTransport,
  createWebSocketTransport,
} from '@riki/realtime';
import type { VoiceDirective } from '@riki/protocol';
import { decodeVoiceDirective, voiceUpdates } from '@riki/protocol';

import type { VoiceBridgePort, VoiceMediaPorts } from './contracts.js';
import type { BridgeToolDispatcher } from './tools.js';
import { createBridgeToolDispatcher } from './tools.js';

export interface VoiceHostDeps {
  readonly bridge: VoiceBridgePort;
  readonly media: VoiceMediaPorts;
  readonly devices: DeviceRegistry;
  /**
   * `schedule` is required, unlike the shape `packages/audio` accepts. It is what bounds a tool
   * call across the bridge (`tools.ts`), and a tool call is the only `await` inside a response
   * that is already being spoken — with no timer, a main process that never answers holds that
   * response open indefinitely.
   */
  readonly clock: { now(): MonoMs; schedule(delayMs: number, fire: () => void): () => void };
  /** `window.fetch`, for the SDP exchange. Injected so the negotiation is testable. */
  readonly fetch: Parameters<typeof createWebRtcTransport>[0]['fetch'];
}

export interface VoiceHost {
  /** Starts listening for directives and announces readiness. Returns the disposer. */
  start(): () => void;
  /**
   * How many times the server reported speech while our gate was shut — the model hearing itself,
   * which is the echo-cancellation failure ADR-0001 chose Electron to avoid.
   *
   * Readable rather than reported because there is no protocol message for it yet (see the
   * header). A non-zero value here with `echoCancellation: true` means AEC is not surviving the
   * Web Audio graph, which is voice-input §13's open question 1.
   */
  readonly selfInterruptions: number;
}

/** What one open session holds, so tearing it down is one object rather than six variables. */
interface LiveSession {
  readonly session: RealtimeSession;
  readonly graph: CaptureGraph;
  readonly playback: PlaybackTracker;
  readonly stream: MicStream;
  readonly unsubscribes: readonly (() => void)[];
  /**
   * Null when main said it has no dispatcher (`VoiceSessionOpen.tools`).
   *
   * ADR-0049 ties the manifest to the presence of a dispatcher, and that coupling is what stops a
   * session advertising five tools that always answer `unknown`. Here it also decides where a
   * `voice.tool.result` goes: with no dispatcher there is nothing that could have asked for one.
   */
  readonly tools: BridgeToolDispatcher | null;
}

function faultFrom(error: unknown): VoiceFault {
  // `AudioFaultError` and `VoiceFaultError` both carry a `kind` and both extend `Error`, so this
  // covers a denied microphone, a missing device, a stale secret and a refused SDP exchange —
  // which is the whole point of them being errors with a kind rather than three shapes.
  const kind = (error as Partial<AudioFault & VoiceFault>).kind;
  const message = error instanceof Error ? error.message : String(error);
  if (kind !== undefined) {
    return {
      kind,
      message,
      persistent: (error as Partial<VoiceFault>).persistent ?? true,
      retryable: (error as Partial<VoiceFault>).retryable ?? false,
    };
  }
  return { kind: 'session-lost', message, persistent: false, retryable: true };
}

export function createVoiceHost(deps: VoiceHostDeps): VoiceHost {
  let live: LiveSession | null = null;
  let levelsEnabled = false;
  let selfInterruptions = 0;

  /**
   * One directive at a time, in arrival order.
   *
   * Opening a session is several awaits long — a device, a graph, a mint, an SDP exchange — and a
   * `voice.turn.begin` that arrives during it must not run against a half-built session or, worse,
   * against the previous one. Chaining onto a promise is the smallest thing that makes "in order"
   * true; a mutex here would be the same thing with more words.
   */
  let queue: Promise<void> = Promise.resolve();

  const send = (update: ReturnType<typeof voiceUpdates.event>): void => {
    deps.bridge.send(update);
  };

  const emit = (event: VoiceEvent): void => {
    // `level` is the only high-rate event, and it is dropped here rather than at the far end so
    // the cost of an idle Riki is zero IPC messages rather than 30 a second that main discards.
    if (event.kind === 'level' && !levelsEnabled) return;
    if (event.kind === 'level') {
      send(voiceUpdates.event({ kind: 'level', source: event.source, value: event.value }));
      return;
    }
    send(voiceUpdates.event(event));
  };

  const fail = (error: unknown): void => {
    const fault = faultFrom(error);
    emit({ kind: 'fault', fault });
    deps.bridge.send(
      voiceUpdates.sessionState(fault.retryable ? 'degraded' : 'unavailable', fault),
    );
  };

  const telemetry: VoiceTelemetry = {
    turnLatency: () => undefined,
    truncation: () => undefined,
    windowDrop: () => undefined,
    fault: () => undefined,
    cost: () => undefined,
    selfInterruption: () => {
      // The AEC canary. Counted and dropped — see the header.
      selfInterruptions += 1;
    },
    /**
     * A call that never reached a tool, and why not.
     *
     * Forwarded rather than counted, which is the opposite of its neighbour above and is the whole
     * of ADR-0049's stated cost: a broken tool layer is *quiet*. Every call degrades politely, the
     * answers get vaguer, and nothing sounds wrong — so if this number died in this renderer, "the
     * model is calling a tool that does not exist, forty times a match" would be indistinguishable
     * from "the model chose not to call anything", which is a thing models do.
     *
     * It is **not** a `fault`. A fault reaches the chip, and a refused tool call is not something
     * to show a player mid-match; it is something to show whoever is reading the inspector. That
     * is what `voice.tool.rejected` exists for, and it is the only thing on this bridge that goes
     * to the Problems panel without going to the overlay.
     *
     * These are also exactly the failures `observeToolCalls` in main **structurally cannot see**
     * (ADR-0047): `parseToolCall` refuses a bad name or bad arguments before anything is
     * dispatched, so there is no dispatch to decorate.
     */
    toolCallRejected: (name, reason) => {
      send(voiceUpdates.toolRejected(name, reason));
    },
  };

  async function closeSession(reason: string): Promise<void> {
    const current = live;
    live = null;
    if (current === null) return;

    // Before anything is torn down. A call still in flight is a promise inside a response that is
    // being spoken, and `session.close` below is what stops the audio — leaving it to the
    // dispatcher's own deadline would mean up to two seconds of a turn nobody is listening to.
    current.tools?.abandon(`the voice session closed (${reason}) before this could be answered`);

    for (const stop of current.unsubscribes) stop();
    // The session first: it is what holds the peer connection, and closing the graph underneath a
    // live connection is how you get a track that ends without the far side being told.
    await current.session.close(reason);
    current.playback.dispose();
    await current.graph.dispose();
    deps.devices.close(current.stream);
    await deps.media.dispose();
    deps.bridge.send(voiceUpdates.sessionState('idle'));
  }

  async function openSession(
    directive: Extract<VoiceDirective, { type: 'voice.session.open' }>,
  ): Promise<void> {
    await closeSession('reopening');
    deps.bridge.send(voiceUpdates.sessionState('connecting'));

    // ADR-0016: the device opens for the whole match, not per key press. Opening one costs
    // 50–300 ms, which is the entire key-down-to-visible budget, and there is nothing to pre-roll
    // from a device that is not running.
    const stream = await deps.devices.open({
      deviceId: directive.capture.deviceId as DeviceId | null,
      echoCancellation: directive.capture.echoCancellation,
      noiseSuppression: directive.capture.noiseSuppression,
      autoGainControl: directive.capture.autoGainControl,
    });

    const backend = await deps.media.createBackend(stream);
    const graph = createCaptureGraph({
      backend,
      clock: deps.clock,
      options: {
        preRollMs: directive.capture.preRollMs,
        gateRampMs: 8,
        levelIntervalMs: 33,
        silenceFloorDb: -50,
      },
    });

    const playback = createPlaybackTracker({
      clock: deps.clock,
      analyserFor: deps.media.analyserFor,
    });

    const transport =
      directive.transport === 'websocket'
        ? createWebSocketTransport({
            // ADR-0002 makes WebRTC the product path, and the socket transport is what
            // `RIKI_REALTIME_TRANSPORT` exists for — but taking it means owning PCM framing,
            // jitter and manual barge-in truncation *in this window*, none of which is written.
            // Failing here names the setting; silently falling back to WebRTC would mean a
            // developer who set it never finds out it did nothing.
            connect: () => {
              throw new Error(
                'RIKI_REALTIME_TRANSPORT=websocket is not wired in the voice window. Use webrtc ' +
                  '(ADR-0002); the socket transport is exercised by fixtures only.',
              );
            },
            now: () => deps.clock.now(),
          })
        : createWebRtcTransport({
            createPeerConnection: deps.media.createPeerConnection,
            fetch: deps.fetch,
            now: () => deps.clock.now(),
          });

    /**
     * The gate, wrapped so `capture` events have a producer.
     *
     * `CapturePort` is open/close/isOpen — the session *gates* capture, it does not observe it —
     * so `capture.opened` and `capture.closed` have to be emitted by whoever holds both objects,
     * which is here (§2.2). `firstAudio` is the first non-silent frame after the gate opens, and
     * it is the signal that distinguishes "listening" from "listening to nothing".
     */
    let sawAudio = false;
    const capture = {
      open: (): void => {
        sawAudio = false;
        graph.open();
        emit({ kind: 'capture', event: 'opened' });
      },
      close: (): void => {
        graph.close();
        emit({ kind: 'capture', event: 'closed' });
      },
      get isOpen(): boolean {
        return graph.isOpen;
      },
    };

    /**
     * The tool layer, or nothing — and ADR-0049 is why it is one or the other and never half.
     *
     * `createRealtimeSession` advertises the manifest **if and only if** a dispatcher is injected,
     * because a session that offers five tools nothing can answer invites five degraded replies a
     * turn. The thing that answers is in main, so the decision is main's and arrives on the
     * directive; all this side does is honour it.
     *
     * Built per session rather than per window: `callId`s restart with the session, and an answer
     * to a call made against a session that has since been replaced has nowhere to go.
     */
    const tools: BridgeToolDispatcher | null = directive.tools
      ? createBridgeToolDispatcher({
          send,
          schedule: (delayMs, fire) => deps.clock.schedule(delayMs, fire),
          onTimeout: (name) => {
            // Deliberately the same channel as a call `packages/realtime` refused: from the
            // inspector's point of view "the model asked for something it could not have" and
            // "main never answered" are the same finding — a tool call that produced no fact —
            // and separating them would be two panels showing halves of one story.
            send(voiceUpdates.toolRejected(name, 'bridge-timeout'));
          },
        })
      : null;

    const secret: RealtimeClientSecret = {
      value: directive.secret.value,
      // Main sent a *duration* — the two processes share no monotonic epoch (schemas/voice.ts).
      // This is where it becomes an instant again, in this process's clock.
      expiresAt: (deps.clock.now() + directive.secret.expiresInMs) as MonoMs,
      sessionId: directive.secret.sessionId as SessionId,
    };

    const session = await createRealtimeSession(
      {
        transport,
        credentials: { acquire: () => Promise.resolve(secret) },
        capture,
        playback,
        clock: deps.clock,
        telemetry,
        // The media the placeholder in `session.ts` stands in for when nothing is injected. Both
        // halves are load-bearing and both fail silently when absent: no outbound track means the
        // model hears nothing, and no `attach` means `audibleMs()` stays zero and barge-in stops
        // truncating.
        media: {
          kind: 'track',
          outbound: graph.outbound,
          onRemoteTrack: (track: RemoteTrack) => {
            playback.attach(track);
            deps.media.play(track);
          },
        },
        // Absent, not null: `SessionDeps.tools` is optional and its *absence* is what sends
        // `tools: []`. Passing `undefined` explicitly would work today and would break the day
        // somebody adds `exactOptionalPropertyTypes`-shaped reasoning to it.
        ...(tools === null ? {} : { tools }),
      },
      { preambleText: directive.session.instructions },
      directive.session,
      { budgetUsd: directive.budgetUsd },
    );

    const unsubscribes = [
      session.onEvent(emit),
      graph.onLevel((sample) => {
        if (graph.isOpen && !sawAudio && sample.rms > 0) {
          sawAudio = true;
          emit({ kind: 'capture', event: 'firstAudio' });
        }
        emit({ kind: 'level', source: 'input', value: sample.rms, at: sample.at });
      }),
      graph.onSpeech((event) => {
        emit({ kind: 'speech', event });
      }),
      playback.onLevel((sample) => {
        emit({ kind: 'level', source: 'output', value: sample.rms, at: sample.at });
      }),
    ];

    live = { session, graph, playback, stream, unsubscribes, tools };
    deps.bridge.send(voiceUpdates.sessionState('ready'));
  }

  async function handle(directive: VoiceDirective): Promise<void> {
    switch (directive.type) {
      case 'voice.session.open':
        await openSession(directive);
        return;

      case 'voice.session.close':
        await closeSession(directive.reason);
        return;

      case 'voice.credential':
        // Nothing to do while the session is open: the secret authenticated the SDP exchange and
        // is not used again. It matters on reconnect and on rotation, and both of those arrive as
        // a fresh `voice.session.open` today. Accepted rather than reported as unknown so the
        // rotation path in main does not have to know that.
        return;

      case 'voice.turn.begin':
        live?.session.turns.beginTurn(directive.mode, deps.clock.now(), directive.turnId as TurnId);
        return;

      case 'voice.turn.end':
        await live?.session.turns.endTurn(directive.turnId as TurnId, directive.reason, {
          turnId: directive.turnId as TurnId,
          snapshotText: directive.snapshotText,
        });
        return;

      case 'voice.turn.speak':
        await live?.session.turns.speakUnprompted(
          { turnId: directive.turnId as TurnId, snapshotText: directive.snapshotText },
          { eventId: directive.eventId, salience: directive.salience },
        );
        return;

      case 'voice.command':
        if (directive.command === 'interrupt') live?.session.interrupt(deps.clock.now());
        else live?.session.abort();
        return;

      case 'voice.window.apply': {
        const applied = await live?.session.window.apply(directive.plan as never);
        if (applied !== undefined) {
          // Copied rather than passed through: zod's inferred arrays are mutable and
          // `AppliedWindowPlan`'s are `readonly`. A cast would compile and would hand the schema a
          // frozen array to validate, which is a different bug on a different day.
          deps.bridge.send(
            voiceUpdates.windowApplied({
              dropped: [...applied.dropped],
              failed: [...applied.failed],
            }),
          );
        }
        return;
      }

      case 'voice.level.enable':
        levelsEnabled = directive.enabled;
        return;

      case 'voice.tool.result':
        // Unreachable, and the reason is the whole point of `settleToolCall` — see `start()`. It
        // is here so that adding a directive still fails this switch rather than falling through.
        return;
    }
  }

  /**
   * Answer one outstanding tool call — **off the queue, and that is load-bearing.**
   *
   * Every other directive is serialised through `queue` so that a `voice.turn.begin` arriving
   * mid-open cannot run against a half-built session. A tool result is the one message that must
   * not be: it is the reply to a request this renderer made, and the request was made from inside
   * an `await` that some earlier directive's handler may still be sitting in. Queueing it behind
   * that handler is a deadlock in which the response never finishes and the answer never arrives —
   * with no error on either side, which is this area's characteristic failure.
   *
   * A result nothing is waiting for is ordinary rather than wrong: our own deadline may have
   * already answered, or the session may have been replaced under it. Dropped in silence, because
   * the model has been told something true either way.
   */
  function settleToolCall(directive: Extract<VoiceDirective, { type: 'voice.tool.result' }>): void {
    live?.tools?.settle(directive.callId, directive.result);
  }

  return {
    get selfInterruptions(): number {
      return selfInterruptions;
    },

    start(): () => void {
      const stop = deps.bridge.onDirective((raw) => {
        const decoded = decodeVoiceDirective(raw);
        if (!decoded.ok) {
          // Never a throw: this runs inside an IPC handler in a renderer with no console anyone is
          // watching, and the symptom of a throw here is a session that stops responding silently.
          fail(
            new Error(
              decoded.reason === 'version'
                ? `The voice window speaks protocol v${String(decoded.theirs)} and main speaks another. This is one build; something is very wrong.`
                : `Unreadable directive: ${decoded.detail}`,
            ),
          );
          return;
        }

        if (decoded.message.type === 'voice.tool.result') {
          // Never queued. See `settleToolCall` — the queue is what a tool result would deadlock on.
          settleToolCall(decoded.message);
          return;
        }

        queue = queue.then(
          () => handle(decoded.message),
          () => handle(decoded.message),
        );
        // The tail of the chain is where a rejection would otherwise become unhandled. Reporting
        // it as a fault is what turns "the session stopped working" into something on the chip.
        queue = queue.catch((error: unknown) => {
          fail(error);
        });
      });

      // Last, and load-bearing: main queues every directive until this arrives, so announcing
      // readiness before the listener is attached would drop the first burst (schemas/voice.ts).
      deps.bridge.send(voiceUpdates.ready());

      return () => {
        stop();
        void closeSession('window disposed');
      };
    },
  };
}
