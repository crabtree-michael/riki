/**
 * @riki/protocol
 *
 * Every message that crosses a process or language boundary is defined here: Electron main
 * ↔ renderer, and Electron ↔ the Rust sidecar.
 *
 * Rules (REPO_SKELETON.md §4): zod is the source of truth; JSON Schema and the Rust types in
 * crates/riki-ipc are generated from it by `pnpm codegen`; every message is versioned; and
 * confidence, provenance and timestamps are non-optional on every CV-derived fact.
 *
 * Changing this package is a coordination event — say so in the commit message.
 *
 * ## What is here, and what is not yet
 *
 * Three boundaries, and only one of them generates anything:
 *
 * - **The sidecar stdio protocol** (`schemas/sidecar.ts`, `codec.ts`). Crosses a *language*
 *   boundary, so `pnpm codegen` turns it into JSON Schema and then into `crates/riki-ipc`.
 * - **The voice window's preload bridge** (`schemas/voice.ts`, `voice-codec.ts`). Main ↔ the hidden
 *   renderer that owns the microphone (ADR-0010). A process boundary but not a language one, so
 *   nothing is generated from it and `crates/riki-ipc` never sees it.
 * - **The tool surface** (`schemas/tools.ts`). What the model may ask the world model for, and the
 *   shape of every answer (ADR-0042, ADR-0043). The peer is a language model rather than another
 *   build of Riki, which is why it is the one surface here with no version field — and the JSON
 *   Schema it is shown is generated at run time by `packages/realtime/src/tools.ts`, not by
 *   `pnpm codegen`.
 *
 * The **overlay's** main ↔ renderer messages are still in `apps/desktop/src/shared`, which is where
 * they were written before this package had any schemas. Moving them is its own coordination event
 * and is not a detail of the voice work: the overlay bridge carries a view model and a level, it is
 * already exercised by the renderer's own tests, and nothing about it is currently going wrong.
 * The voice bridge is here rather than beside it because `voice-input-architecture.md` §12 asks for
 * it and because it carries the session config, where a shape that has drifted does not error — it
 * misconfigures the session.
 */

export { PROTOCOL_VERSION } from './version.js';
export * from './schemas/sidecar.js';
export {
  commands,
  decodeSidecarCommand,
  decodeSidecarEvent,
  encodeMessage,
  type DecodedCommand,
  type DecodedEvent,
} from './codec.js';

export {
  VOICE_PROTOCOL_VERSION,
  VoiceDirective,
  VoiceEvent,
  VoiceProtocol,
  VoiceUpdate,
} from './schemas/voice.js';
export type {
  AppliedWindowPlan,
  CaptureRequest,
  ClientSecret,
  RealtimeSessionConfig,
  VoiceFault,
  WindowPlan,
} from './schemas/voice.js';
export {
  decodeVoiceDirective,
  decodeVoiceUpdate,
  voice,
  voiceUpdates,
  type Decoded,
} from './voice-codec.js';

export {
  AbilityReport,
  BuildingsReport,
  EconomyArguments,
  EconomyReport,
  EconomyResult,
  EnemiesReport,
  EnemyArguments,
  EnemyReport,
  EnemyResult,
  FactSource,
  GameClock,
  ItemReport,
  MapPoint,
  MyStateArguments,
  MyStateReport,
  MyStateResult,
  ObjectivesArguments,
  ObjectivesReport,
  ObjectivesResult,
  RoshanReport,
  RuneReport,
  TOOLS,
  ToolName,
  UNKNOWN_REASONS,
  UnknownFact,
  WorldAtArguments,
  WorldAtReport,
  WorldAtResult,
  formatGameClock,
  isUnknown,
  orUnknown,
  parseGameClock,
  toolFact,
} from './schemas/tools.js';
export type {
  KnownFact,
  ToolAnswer,
  ToolArgumentsFor,
  ToolFact,
  ToolInvocation,
  ToolResultFor,
  ToolSpec,
} from './schemas/tools.js';
