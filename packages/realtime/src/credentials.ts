/**
 * Minting the ephemeral client secret — ADR-0015.
 *
 * Three prior decisions meet here and look contradictory: the peer connection is in a renderer
 * (ADR-0002), the credential is an environment variable (ADR-0006), and the key is read in exactly
 * one module in the main process and never crosses the preload bridge (REPO_SKELETON.md §7.1).
 *
 * The API's own answer for browsers resolves it: main is Riki's token-minting service. This class
 * runs in main, holds the injected key, and hands the renderer a short-lived secret. When
 * REPO_SKELETON.md §11.2 is settled and a real minting service exists, it replaces this
 * implementation and nothing else.
 *
 * See docs/design/voice-input-architecture.md §5.1. Declarations only.
 */

import type { MonoMs, SessionId } from './types.js';
import type { RealtimeSessionConfig } from './session-config.js';

export interface ClientSecret {
  readonly value: string;
  readonly expiresAt: MonoMs;
  readonly sessionId: SessionId;
}

/** Narrow on purpose: this package must be testable with a stub and no network. */
export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export interface RequestInitLike {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface ClientSecretBrokerDeps {
  /**
   * Injected by the composition root from `packages/config`. This package never reads
   * `process.env`, and a lint boundary enforces it (REPO_SKELETON.md §6.2).
   */
  readonly apiKey: string;
  /**
   * A stable hashed install id, computed in main. realtime §6 is explicit that a client-supplied
   * safety identifier is worthless for abuse attribution, and dota2 §7 requires the Steam ID be
   * hashed before any egress — both point at this being set here and nowhere else.
   */
  readonly safetyIdentifier: string;
  readonly fetch: FetchLike;
  readonly now: () => MonoMs;
}

export interface ClientSecretBroker {
  /**
   * Rejects with a `VoiceFault`: 401 is `auth` and never retried in a loop — it names
   * `RIKI_OPENAI_API_KEY` — while 429 is `offline` after backoff.
   */
  mint(config: RealtimeSessionConfig): Promise<ClientSecret>;
}

export declare function createClientSecretBroker(deps: ClientSecretBrokerDeps): ClientSecretBroker;

/**
 * The renderer's view: it can ask for a credential and cannot ask for a key, because there is no
 * method that would return one. Implemented over the preload bridge.
 */
export interface CredentialPort {
  acquire(): Promise<ClientSecret>;
}
