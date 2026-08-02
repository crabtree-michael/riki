/**
 * `apps/desktop/src/main/voice/` — the main-process half of the voice path.
 *
 * voice-input-architecture.md §7.3: the one place where `@riki/config`'s key, `ClientSecretBroker`,
 * the voice window and the coaching agent's `CoachingSessionPort` all appear together. None of the
 * packages involved import each other.
 *
 * `electron-window.ts` is the only file here that imports Electron, so everything else is a Tier 1
 * test.
 */

export type { VoiceWindow, VoiceWindowFactory } from './contracts.js';
export { createElectronVoiceWindowFactory } from './electron-window.js';
export type { ElectronVoiceWindowOptions } from './electron-window.js';
export { createVoiceSession, resetVoiceTurnIds } from './session.js';
export type {
  VoiceSession,
  VoiceSessionDeps,
  VoiceSessionState,
  VoiceSessionTelemetry,
} from './session.js';
