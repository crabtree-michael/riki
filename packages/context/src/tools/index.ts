/**
 * Tier 3 — the command surface the agent can call (dota2-state-capture-design.md §6.3).
 *
 * Detail the agent pulls when it needs it, which is what keeps the Tier 2 snapshot small. A command
 * reads what has already been observed; nothing here reaches into the game (ADR-0003).
 *
 * Architecture: docs/design/agent-command-execution-architecture.md.
 *
 * `buildToolSurface()` is the whole public surface. Everything else is exported for tests and for
 * the composition root's own wiring; nothing outside this package should need to construct a stage.
 */

export type * from './types.js';
export type * from './ports.js';
export type * from './contracts.js';

export { buildToolSurface } from './surface.js';
export type { AgentToolSurface, ToolSurfaceDeps } from './surface.js';

export { defineTool, createRegistry } from './registry.js';
export type { ToolSpec } from './registry.js';
export { defineArgs, NO_ARGS } from './codec.js';
export type { ArgsOf, DeclaredCodec, FieldSpec, FieldSpecs, SubjectKind } from './codec.js';
export {
  fail,
  failure,
  ok,
  isRetryable,
  speakableFor,
  unknownSubject,
  unknownTool,
} from './failures.js';
export { createParser, fingerprint } from './parse.js';
export { createSubjectResolver, resolveSubjects, subjectsFrom } from './resolve.js';
export {
  createAdmissionController,
  consentRequestFor,
  RateLimiter,
  ALWAYS_HEALTHY,
} from './admission.js';
export type { AdmissionDeps, PortHealth } from './admission.js';
export { createPortBreaker } from './breaker.js';
export type { BreakerOptions } from './breaker.js';
export { createToolQueue, effectiveDeadline } from './queue.js';
export type { QueueOptions } from './queue.js';
export { createExecutor } from './executor.js';
export type { ExecutorDeps } from './executor.js';
export { createFreshCaptureRequest } from './fresh.js';
export type { FreshCaptureDeps } from './fresh.js';
export { buildManifest, estimateEntryTokens, includedIn } from './manifest.js';
export { Turn, TurnResultMemo, MutableCancelSignal } from './turn.js';
export { systemTimers } from './timers.js';
export type { Timers } from './timers.js';
export { DEFAULT_TUNABLES, EFFECT_DEFAULTS } from './tunables.js';
export type { EffectDefaults, ToolTunables } from './tunables.js';
export { ALL_HANDLERS } from './all-handlers.js';
export { compose, field, allowedByPrivacy, clockText, duration } from './render.js';
export type { Part } from './render.js';
export {
  HERO_BY_SPOKEN,
  ITEM_BY_SPOKEN,
  KNOWN_REGIONS,
  REGION_BY_SPOKEN,
  normalise,
} from './aliases.js';
