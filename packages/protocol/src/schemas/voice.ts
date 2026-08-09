/**
 * The voice window's preload bridge: Electron main ↔ the hidden renderer that owns the microphone.
 *
 * ADR-0010 puts `getUserMedia`, the Web Audio graph and the WebRTC peer connection in a renderer of
 * their own, because Chromium's echo canceller exists nowhere else and a live conversation must not
 * share a lifetime with a window that is shown and hidden on every key press. Everything main knows
 * about that renderer is in this file — `voice-input-architecture.md` §12 is the table it comes
 * from.
 *
 * ## Three things never cross, and two of them are structural
 *
 * **Raw PCM** and **a `MediaStreamTrack`** cannot: the peer connection lives entirely on the
 * renderer side, so the audio never has a reason to be serialised (ADR-0002, architecture §2.3).
 *
 * **The API key** must not, and here it cannot. `VoiceSessionOpen` carries a `ClientSecret` —
 * short-lived, minted in main by `ClientSecretBroker` from the injected `ApiKey` (ADR-0015) — and
 * there is no field on any message in this file that could hold a key. REPO_SKELETON.md §5.4 asks
 * for a test that the key is absent from the preload bridge surface; that becomes a statement about
 * a shape rather than a rule someone has to keep.
 *
 * ## No `MonoMs` crosses this bridge
 *
 * Main and the renderer are different processes, so `performance.timeOrigin` differs and a
 * monotonic timestamp from one is meaningless to the other. This is the same trap the sidecar
 * protocol documents, and it is worse here because both numbers *look* like uptimes and would
 * silently be off by however long the renderer took to start.
 *
 * So: `ClientSecret` carries `expiresInMs`, a duration, rather than an absolute expiry. Level
 * frames carry no timestamp and are stamped by main on receipt — the overlay smooths them for
 * display and only needs a consistent clock, which main's is. `VoiceTurnBegin` carries none because
 * `TurnController.beginTurn` discards the one it is given.
 *
 * `VoiceCommand.interrupt` carries none for the same reason: `TurnController.interrupt(at)` takes a
 * moment and discards it, truncating at `PlaybackTracker.audibleMs()` instead. If that ever changes
 * the field is a **duration** — how long ago the player interrupted — not a timestamp.
 *
 * ## Who allocates a turn id
 *
 * Main does. `TurnId` is the join key for the conversation ledger, the coaching memory and the
 * interaction machine, all of which are main's, and `CoachingAgent.beginPlayerTurn` has to return
 * one *synchronously* — the overlay's ≤100 ms budget forbids an await between the key press and the
 * window being shown. An id allocated in the renderer could only come back asynchronously. So
 * `VoiceTurnBegin` carries the id and the renderer obeys it.
 *
 * ## The one request on this bridge
 *
 * Every other message here is one-way. `voice.tool.call` / `voice.tool.result` are a correlated
 * pair, joined by `callId`, and they exist because of where the two halves of a tool call live:
 * the Realtime session runs in this renderer (ADR-0010) and a `WorldState` may only be read in
 * main (ADR-0002, ADR-0015). ADR-0042 gave the model five tools; without this pair nothing could
 * answer one, so `apps/desktop` injected no dispatcher and every live session went out with
 * `tools: []` — which is what T12 was raised to fix, after a match's worth of ungrounded answers.
 *
 * Three properties, each of which has a failure behind it:
 *
 * - **`VoiceSessionOpen.tools` says whether main will answer.** ADR-0049 ties the manifest to the
 *   presence of a dispatcher: advertising five tools that always answer `unknown` is strictly
 *   worse than advertising none. The dispatcher is on main's side of the bridge, so the renderer
 *   cannot see it and has to be told.
 * - **A call carries a `ToolName` and an object, not a hand-written argument schema.** The shapes
 *   are `schemas/tools.ts`'s and are validated by `packages/realtime` on the way out of the model
 *   and by main on the way in, both against `TOOLS[name]`. A second declaration of them here would
 *   drift the first time a tool changed shape — which is the failure that file exists to prevent.
 * - **An unanswered call is not a stuck turn.** A tool call is the only `await` inside a response
 *   that is already being spoken, so the renderer times the request out and answers itself with
 *   `{ unknown: … }` (ADR-0043, ADR-0049). Nothing on this bridge may make a sentence stop.
 *
 * Consent, which shared §12's row, is still absent: ADR-0023 deleted the pull model it belonged to
 * and ADR-0042 did not bring it back.
 *
 * ## No Rust half
 *
 * `scripts/codegen.mjs` generates Rust only from `SidecarProtocol`. These messages cross a process
 * boundary but not a language one, so there is nothing to generate and `crates/riki-ipc` never sees
 * them. The Tier 3 corpus in `fixtures/protocol/voice/` is therefore a TypeScript-only round trip:
 * it still catches a schema that has drifted from the shape main and the renderer actually send,
 * which is the failure a same-build bridge really has.
 */

import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version.js';
import { ToolName } from './tools.js';

const version = z.int().min(1).describe('Protocol version this message was written against.');

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * The Realtime models Riki may open a session with.
 *
 * The mini model is the default and the main cost lever (realtime research §10). A closed set
 * rather than a string, so a typo in `RIKI_REALTIME_MODEL` fails in `packages/config` at startup
 * rather than as an opaque 400 the first time the player presses the key.
 */
export const ModelId = z
  .enum(['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'])
  .meta({ id: 'ModelId', description: 'An OpenAI Realtime model Riki can run against.' });

/** Locked once audio starts, so it is a per-session choice (realtime research §11.8). */
export const VoiceName = z
  .enum(['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'])
  .meta({ id: 'VoiceName', description: "The Realtime API's voice for this session." });

export const CaptureMode = z
  .enum(['push', 'latch'])
  .meta({ id: 'CaptureMode', description: 'Held for the utterance, or tapped to latch open.' });

export const TurnEndReason = z
  .enum(['release', 'latch-tap', 'timeout', 'cancel'])
  .meta({ id: 'TurnEndReason', description: 'Why a capture turn stopped.' });

/**
 * Exactly the overlay's `FaultKind` minus `no-speech-detected`, which is the interaction machine's
 * own listen-timeout expiring and never something the session can observe. The sets matching is
 * what makes the adapter in `main/adapters/voice.ts` the identity rather than a table.
 */
export const VoiceFaultKind = z
  .enum(['mic-denied', 'no-input-device', 'offline', 'auth', 'session-lost'])
  .meta({ id: 'VoiceFaultKind', description: 'A fault the voice path can produce.' });

export const VoiceFault = z
  .object({
    kind: VoiceFaultKind,
    message: z.string(),
    /** Permission and device faults stay up until resolved; the rest auto-dismiss (ui-design §8). */
    persistent: z.boolean(),
    /** `auth` never is — it names `RIKI_OPENAI_API_KEY` instead of retrying in a loop. */
    retryable: z.boolean(),
  })
  .meta({ id: 'VoiceFault' });

/**
 * The four words the local parser recognises without the model (voice-input §6.2).
 *
 * They must work when the session is unavailable, which is the whole reason they are parsed from a
 * transcript locally rather than dispatched by the model.
 */
export const LocalCommandKind = z
  .enum(['stop', 'mute', 'quiet-mode', 'cancel'])
  .meta({ id: 'LocalCommandKind' });

/**
 * A tool's arguments, or a tool's result, as they cross the bridge.
 *
 * Deliberately just "a JSON object". The real shapes are `schemas/tools.ts`'s and both ends
 * already validate against them — `packages/realtime`'s `parseToolCall` before a call leaves the
 * renderer and `encodeToolOutput` when its result comes back, `TOOLS[name].arguments.safeParse` in
 * main before anything is dispatched. Restating them here would be a third declaration of the tool
 * set, and the first one to drift would be this one, silently: a bridge that rejected a valid call
 * looks exactly like a model that chose not to call anything.
 *
 * What this *does* pin is that a payload is an object. `ToolFact` is a union whose `unknown`
 * branch is an object, every argument schema is a `strictObject`, and a bare string or array
 * arriving here would be a bug in whoever built the message rather than something to forward.
 */
const ToolPayload = z
  .record(z.string(), z.unknown())
  .meta({ id: 'ToolPayload', description: 'A tool call’s arguments, or its result.' });

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/**
 * What the renderer authenticates with, and the only credential that ever crosses.
 *
 * Minted in main by `ClientSecretBroker` (ADR-0015). `expiresInMs` rather than an absolute expiry
 * because the two processes do not share a monotonic epoch — see the header. A stale secret is an
 * ordinary event on this side of the bridge, handled on reconnect and on session rotation, not a
 * fatal error.
 */
export const ClientSecret = z
  .object({
    value: z.string().min(1),
    /** Time remaining when the message was sent. Short, or an ephemeral secret is just a key. */
    expiresInMs: z.int().min(0),
    sessionId: z.string().min(1),
  })
  .meta({ id: 'ClientSecret' });

// ---------------------------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------------------------

/**
 * ADR-0017: VAD stays on so server-side barge-in truncation keeps working, and `createResponse` is
 * the literal `false` because the gesture — never the model — decides when a response is created.
 * A schema that cannot express `true` is how that stays true after the next refactor.
 */
export const TurnDetectionConfig = z
  .object({
    kind: z.enum(['server_vad', 'semantic_vad', 'none']),
    createResponse: z.literal(false),
    interruptResponse: z.boolean(),
    /** Default 200. Sits directly on the release → response path (voice-input §5.4). */
    silenceDurationMs: z.int().min(0),
  })
  .meta({ id: 'TurnDetectionConfig' });

export const TranscriptionConfig = z
  .object({
    model: z.string().min(1),
    language: z.string().min(1).nullable(),
  })
  .meta({ id: 'TranscriptionConfig' });

/**
 * `retentionRatio: 0.8` is counter-intuitive and deliberate: every truncation busts the prompt
 * cache, so trimming aggressively but rarely is much cheaper than trimming minimally and constantly
 * (realtime research §5).
 */
export const TruncationConfig = z
  .object({
    mode: z.enum(['auto', 'disabled']),
    retentionRatio: z.number().min(0).max(1),
  })
  .meta({ id: 'TruncationConfig' });

/**
 * Riki's vocabulary for a session, not the API's.
 *
 * The GA/beta schema trap (`session-config.ts`) lives entirely on the renderer side: this carries
 * no `input_audio_format`, no top-level `voice` in the API's sense, and no `modalities`, because
 * the type has no such fields. `buildSessionUpdate` is still the only producer of a wire payload
 * and `assertGaShape` still runs on the way out — this is one more layer, not a replacement.
 */
export const RealtimeSessionConfig = z
  .object({
    model: ModelId,
    voice: VoiceName,
    /** The preamble, from `packages/context`. The whole of the cached prefix. */
    instructions: z.string(),
    turnDetection: TurnDetectionConfig,
    /** `far_field` for a desk mic, `near_field` for a headset (voice-input §3.4). */
    noiseReduction: z.enum(['near_field', 'far_field']).nullable(),
    transcription: TranscriptionConfig.nullable(),
    truncation: TruncationConfig,
  })
  .meta({ id: 'RealtimeSessionConfig' });

/**
 * What to ask `getUserMedia` for, and how much audio to keep from before the key press.
 *
 * `echoCancellation` is a field rather than a constant so a test can prove the self-interruption
 * loop exists; it is never false on the product path. Without it the model hears itself and
 * interrupts itself in a loop, which is the failure ADR-0001 chose Electron over Tauri to avoid.
 */
export const CaptureRequest = z
  .object({
    /** Null is the system default, which is what a fresh install uses. */
    deviceId: z.string().min(1).nullable(),
    echoCancellation: z.boolean(),
    noiseSuppression: z.boolean(),
    autoGainControl: z.boolean(),
    /** The delay line that makes "audio from before the key press" possible. May be zero. */
    preRollMs: z.int().min(0),
  })
  .meta({ id: 'CaptureRequest' });

// ---------------------------------------------------------------------------------------------
// The context window
// ---------------------------------------------------------------------------------------------

/** A position in `packages/context`'s conversation ledger (ADR-0012). Opaque to the renderer. */
export const LedgerRef = z.int().meta({ id: 'LedgerRef' });

/**
 * What should leave the window and what replaces it — `packages/context` plans, the renderer's
 * `ContextWindowExecutor` performs (voice-input §5.6).
 *
 * The summary item is created *before* what it replaces is deleted. The opposite order leaves a
 * window that has forgotten a stretch of the match and does not yet have the replacement.
 */
export const WindowPlan = z
  .object({
    drop: z.array(LedgerRef),
    replace: z.array(
      z.object({
        refs: z.array(LedgerRef),
        with: z.object({ text: z.string(), tokens: z.int().min(0) }),
      }),
    ),
    estimatedTokensAfter: z.int().min(0),
    reason: z.enum(['low_water', 'quiet_moment', 'forced']),
  })
  .meta({ id: 'WindowPlan' });

export const AppliedWindowPlan = z
  .object({
    dropped: z.array(LedgerRef),
    /** A delete the API refuses is a failed ref, not an exception. Nothing here throws. */
    failed: z.array(LedgerRef),
  })
  .meta({ id: 'AppliedWindowPlan' });

// ---------------------------------------------------------------------------------------------
// main → renderer
// ---------------------------------------------------------------------------------------------

/**
 * Every message carries `v` and `type`, and those two fields are frozen for all time — the same
 * rule `version.ts` states for the sidecar, and for the same reason: a mismatched peer's message
 * must stay parseable *enough* to be recognised as a mismatch rather than fail three layers down.
 * Written out per message rather than through a helper, because a generic wrapper here defeats
 * `z.discriminatedUnion`'s ability to see the literal.
 */
export const VoiceSessionOpen = z
  .object({
    v: version,
    type: z.literal('voice.session.open'),
    secret: ClientSecret,
    session: RealtimeSessionConfig,
    capture: CaptureRequest,
    transport: z.enum(['webrtc', 'websocket']),
    /** The soft ceiling the cost meter warns at, in USD. */
    budgetUsd: z.number().positive(),
    /**
     * Whether main will answer a `voice.tool.call`, and therefore whether the session advertises
     * the tool manifest at all (ADR-0049).
     *
     * The renderer builds the dispatcher — it is the side that owns the session — but the thing
     * that answers is on the far side of this bridge, so the decision is not the renderer's to
     * make. False is the pre-ADR-0042 session: `tools: []` goes out and a call could only be one
     * the model invented.
     */
    tools: z.boolean(),
  })
  .meta({ id: 'VoiceSessionOpen' });

export const VoiceSessionClose = z
  .object({
    v: version,
    type: z.literal('voice.session.close'),
    reason: z.string(),
  })
  .meta({ id: 'VoiceSessionClose' });

/**
 * A fresh secret without a fresh session.
 *
 * Rotation and reconnection are the same machinery with different triggers (`SessionSupervisor`),
 * and both need a credential the renderer did not have when the window opened.
 */
export const VoiceCredential = z
  .object({
    v: version,
    type: z.literal('voice.credential'),
    secret: ClientSecret,
  })
  .meta({ id: 'VoiceCredential' });

export const VoiceTurnBegin = z
  .object({
    v: version,
    type: z.literal('voice.turn.begin'),
    /** Allocated in main — see the header. */
    turnId: z.string().min(1),
    mode: CaptureMode,
  })
  .meta({ id: 'VoiceTurnBegin' });

export const VoiceTurnEnd = z
  .object({
    v: version,
    type: z.literal('voice.turn.end'),
    turnId: z.string().min(1),
    reason: TurnEndReason,
    /**
     * The snapshot and the brief, already composed into one system message by the coaching agent.
     * The renderer puts it on the wire and never inspects it — which is exactly why the *whole*
     * coaching pipeline stays on the main side and testable without a session.
     */
    snapshotText: z.string(),
  })
  .meta({ id: 'VoiceTurnEnd' });

/**
 * The proactive path: no capture, no gesture, straight to a response (dota2 §6.4, ADR-0023).
 *
 * `eventId` and `salience` ride along for the ledger. The renderer does not read them; they are
 * here so a turn in the transcript can be traced back to the detection that caused it.
 */
export const VoiceTurnSpeak = z
  .object({
    v: version,
    type: z.literal('voice.turn.speak'),
    turnId: z.string().min(1),
    snapshotText: z.string(),
    eventId: z.string(),
    salience: z.number(),
  })
  .meta({ id: 'VoiceTurnSpeak' });

/** Barge-in and `Esc`. No timestamp — see the header. */
export const VoiceCommand = z
  .object({
    v: version,
    type: z.literal('voice.command'),
    command: z.enum(['interrupt', 'abort']),
  })
  .meta({ id: 'VoiceCommand' });

export const VoiceWindowApply = z
  .object({
    v: version,
    type: z.literal('voice.window.apply'),
    plan: WindowPlan,
  })
  .meta({ id: 'VoiceWindowApply' });

/**
 * Whether to send level frames at all.
 *
 * Overlay §5.5: they cross at 30 Hz *while the chip can show bars* and not otherwise. Off is the
 * resting state, so an idle Riki costs one IPC message per interaction rather than 30 per second
 * forever — which is what makes "idle costs literally nothing" (ui-design §10) true of the voice
 * window too, not just of the overlay.
 */
export const VoiceLevelEnable = z
  .object({
    v: version,
    type: z.literal('voice.level.enable'),
    enabled: z.boolean(),
  })
  .meta({ id: 'VoiceLevelEnable' });

/**
 * The answer to one `voice.tool.call`, joined by `callId`.
 *
 * `result` is whatever `TOOLS[name].result` accepts, which for all five includes `{ unknown: … }`
 * — so main answers a tool that threw, a tool it could not build and a call whose arguments no
 * longer parse in exactly the shape the model already reads for a fact nobody observed (ADR-0043).
 * There is no error branch on this message and there should never be one: a second vocabulary for
 * "I could not get that" would have to be prompted for and tested to produce the same spoken
 * sentence (ADR-0049).
 *
 * A result for a call the renderer has already given up on is dropped, and that is not an error
 * either — main cannot know the renderer's timeout has fired, and the model has already been told
 * something true.
 */
export const VoiceToolResult = z
  .object({
    v: version,
    type: z.literal('voice.tool.result'),
    /** The `callId` of the `voice.tool.call` this answers. Allocated by the renderer. */
    callId: z.string().min(1),
    result: ToolPayload,
  })
  .meta({ id: 'VoiceToolResult' });

export const VoiceDirective = z
  .discriminatedUnion('type', [
    VoiceSessionOpen,
    VoiceSessionClose,
    VoiceCredential,
    VoiceTurnBegin,
    VoiceTurnEnd,
    VoiceTurnSpeak,
    VoiceCommand,
    VoiceWindowApply,
    VoiceLevelEnable,
    VoiceToolResult,
  ])
  .meta({ id: 'VoiceDirective', description: 'Electron main → the hidden voice renderer.' });

// ---------------------------------------------------------------------------------------------
// renderer → main
// ---------------------------------------------------------------------------------------------

/**
 * The vendor-free event stream, and the reason the interaction machine has never heard of
 * `response.output_audio.done`.
 *
 * When the Realtime API renames an event — research §3 documents that it already did once,
 * silently — the diff stops in the renderer's `wire.ts`. Nothing on this side of the bridge moves.
 */
export const VoiceEvent = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('capture'),
      event: z.enum(['opened', 'firstAudio', 'closed']),
    }),
    z.object({ kind: z.literal('speech'), event: z.enum(['silence', 'resumed']) }),
    z.object({
      kind: z.literal('turn'),
      turnId: z.string(),
      event: z.enum(['submitted', 'responseStarted', 'responseEnded']),
    }),
    z.object({
      kind: z.literal('transcript'),
      role: z.enum(['player', 'agent']),
      turnId: z.string(),
      text: z.string(),
      final: z.boolean(),
    }),
    z.object({
      kind: z.literal('command'),
      command: LocalCommandKind,
      confidence: z.number(),
    }),
    /**
     * No timestamp: main stamps these on receipt. The two processes do not share a monotonic
     * epoch, and the overlay only needs a consistent clock for its display smoothing — main's is.
     */
    z.object({
      kind: z.literal('level'),
      source: z.enum(['input', 'output']),
      value: z.number().min(0).max(1),
    }),
    z.object({ kind: z.literal('cost'), usd: z.number(), turns: z.int().min(0) }),
    z.object({ kind: z.literal('fault'), fault: VoiceFault }),
  ])
  .meta({ id: 'VoiceEvent', description: 'What the voice renderer reports, in Riki vocabulary.' });

/**
 * The document has loaded and its bridge is attached.
 *
 * Load-bearing rather than a courtesy: a `voice.session.open` sent before this is a message with no
 * listener, and the failure it produces is a session that never opens and never errors — the
 * hardest bug class in this area to reproduce. Main queues directives until it arrives.
 */
export const VoiceReady = z
  .object({
    v: version,
    type: z.literal('voice.ready'),
    /** So a mismatched build is a clear error rather than a parse failure three layers down. */
    rendererProtocolVersion: z.int().min(1),
  })
  .meta({ id: 'VoiceReady' });

export const VoiceEventMessage = z
  .object({
    v: version,
    type: z.literal('voice.event'),
    event: VoiceEvent,
  })
  .meta({ id: 'VoiceEventMessage' });

export const VoiceSessionState = z
  .object({
    v: version,
    type: z.literal('voice.session.state'),
    state: z.enum(['idle', 'connecting', 'ready', 'degraded', 'unavailable']),
    /** Present when the state is `degraded` or `unavailable`, and only then. */
    fault: VoiceFault.nullable(),
  })
  .meta({ id: 'VoiceSessionState' });

export const VoiceWindowApplied = z
  .object({
    v: version,
    type: z.literal('voice.window.applied'),
    applied: AppliedWindowPlan,
  })
  .meta({ id: 'VoiceWindowApplied' });

/**
 * The model asked the world a question, and only main can read the world.
 *
 * The one message on this bridge that expects a reply. `callId` is the renderer's own sequence
 * number and has nothing to do with the Realtime API's `call_id` — the model's id addresses a
 * `function_call_output` on the far side of the session and never crosses to main, which has no
 * business knowing a conversation item exists.
 *
 * `name` is `schemas/tools.ts`'s `ToolName`, so adding a tool widens this message with it and a
 * name outside the five cannot be sent at all. By the time a call is built the arguments have
 * already been parsed against `TOOLS[name].arguments` by `packages/realtime`; main parses them
 * again, because a bridge is exactly where a shape drifts without anyone noticing.
 */
export const VoiceToolCall = z
  .object({
    v: version,
    type: z.literal('voice.tool.call'),
    callId: z.string().min(1),
    name: ToolName,
    args: ToolPayload,
  })
  .meta({ id: 'VoiceToolCall' });

/**
 * A tool call that never reached a dispatcher, and why not.
 *
 * The failures on the *renderer's* side of the pair above: a name outside the five, arguments the
 * schema refuses, a call with no id to answer to. `packages/realtime` refuses all of them before
 * anything is dispatched, which is right — and which is exactly why they are the one thing main's
 * dispatch decorator structurally cannot see (ADR-0047).
 *
 * A separate message rather than a `VoiceEvent`, because a `VoiceEvent` reaches the overlay and
 * this must not: ADR-0049 chose a vaguer sentence over an error the player can do nothing with.
 * It goes to the inspector, where somebody reading a run of vague answers can find the cause.
 *
 * `name` is a bare string and not a `ToolName` on purpose — a call for a tool that does not exist
 * is still a call, and the name the model invented is the most useful field on this message.
 */
export const VoiceToolRejected = z
  .object({
    v: version,
    type: z.literal('voice.tool.rejected'),
    name: z.string(),
    /** `packages/realtime`'s `ToolCallRejection`, as prose. Not an enum: it is read, not switched. */
    reason: z.string().min(1),
  })
  .meta({ id: 'VoiceToolRejected' });

export const VoiceUpdate = z
  .discriminatedUnion('type', [
    VoiceReady,
    VoiceEventMessage,
    VoiceSessionState,
    VoiceWindowApplied,
    VoiceToolCall,
    VoiceToolRejected,
  ])
  .meta({ id: 'VoiceUpdate', description: 'The hidden voice renderer → Electron main.' });

/** Both directions in one root, so `$defs` resolves every named schema above. */
export const VoiceProtocol = z
  .object({ directive: VoiceDirective, update: VoiceUpdate })
  .meta({ id: 'VoiceProtocol' });

export type ClientSecret = z.infer<typeof ClientSecret>;
export type RealtimeSessionConfig = z.infer<typeof RealtimeSessionConfig>;
export type CaptureRequest = z.infer<typeof CaptureRequest>;
export type WindowPlan = z.infer<typeof WindowPlan>;
export type AppliedWindowPlan = z.infer<typeof AppliedWindowPlan>;
export type VoiceFault = z.infer<typeof VoiceFault>;
export type VoiceEvent = z.infer<typeof VoiceEvent>;
export type VoiceDirective = z.infer<typeof VoiceDirective>;
export type VoiceUpdate = z.infer<typeof VoiceUpdate>;

/** Stamped on every message this build sends. */
export const VOICE_PROTOCOL_VERSION = PROTOCOL_VERSION;
