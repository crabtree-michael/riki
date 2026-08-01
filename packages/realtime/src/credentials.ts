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
 * See docs/design/voice-input-architecture.md §5.1.
 *
 * ## Why `apiKey` is an `ApiKey` and not a `string` — ADR-0022
 *
 * The lint boundary in REPO_SKELETON.md §6.2 stops this package *reading* the environment, which
 * covers the deliberate leak. It does nothing about the accidental one, and the accidental one is
 * the realistic one: `JSON.stringify(deps)` in a telemetry call, a key interpolated into an error
 * message, `console.log` of a config object in main. No lint rule sees any of those.
 *
 * `ApiKey` closes the whole class by construction — it renders as `[redacted]` through `toString`,
 * `toJSON` *and* `util.inspect`, and the only way to the real value is a method named to look
 * wrong in a log statement.
 */

import type { MonoMs, SessionId, VoiceFault } from './types.js';
import type { RealtimeSessionConfig } from './session-config.js';

const REDACTED = '[redacted]';

/**
 * The API key, in a wrapper that cannot be logged by accident.
 *
 * Constructed in exactly one place — `packages/config`, in main (REPO_SKELETON.md §7.1) — and
 * never crosses the preload bridge in any form.
 */
export class ApiKey {
  readonly #value: string;

  constructor(value: string) {
    if (value.trim() === '') {
      throw new Error('RIKI_OPENAI_API_KEY is empty. See REPO_SKELETON.md §7.1.');
    }
    this.#value = value;
  }

  /** The only way out. Named to be greppable, and to look wrong in a log statement. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** What `console.log` in main actually calls. `toString` does not cover this path. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

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
   * `process.env`, and a lint boundary enforces it (REPO_SKELETON.md §6.2). An `ApiKey` rather
   * than a `string` so it cannot reach a log by accident — ADR-0022.
   */
  readonly apiKey: ApiKey;
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

export const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

/** realtime §12: the mint endpoint becomes the abuse vector if it is not rate limited. */
export const MIN_MINT_INTERVAL_MS = 1_000;

/** Short, because an ephemeral secret that outlives its usefulness is just a key again. */
const DEFAULT_TTL_MS = 60_000;

/**
 * A `VoiceFault` that is also an `Error`.
 *
 * The contract says `mint` "rejects with a `VoiceFault`", and a bare object satisfies that
 * structurally — but it arrives at the catch site with no stack, which for a credential failure
 * ten minutes into a match is the difference between a diagnosable report and a shrug. Extending
 * `Error` keeps the declared shape (every `VoiceFault` field is present, including `message`,
 * which `Error` already has) and adds the trace.
 */
export class VoiceFaultError extends Error implements VoiceFault {
  readonly kind: VoiceFault['kind'];
  readonly persistent: boolean;
  readonly retryable: boolean;

  constructor(kind: VoiceFault['kind'], message: string, retryable: boolean) {
    super(message);
    this.name = 'VoiceFaultError';
    this.kind = kind;
    this.retryable = retryable;
    // Permission and auth faults persist until resolved; the rest auto-dismiss (ui-design §8).
    this.persistent = !retryable;
  }
}

function fault(kind: VoiceFault['kind'], message: string, retryable: boolean): VoiceFaultError {
  return new VoiceFaultError(kind, message, retryable);
}

export function createClientSecretBroker(deps: ClientSecretBrokerDeps): ClientSecretBroker {
  let lastMintAt: MonoMs | null = null;

  return {
    async mint(config: RealtimeSessionConfig) {
      const now = deps.now();
      if (lastMintAt !== null && now - lastMintAt < MIN_MINT_INTERVAL_MS) {
        throw fault('offline', 'Refusing to mint a client secret more than once per second.', true);
      }
      lastMintAt = now;

      let response;
      try {
        response = await deps.fetch(CLIENT_SECRETS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${deps.apiKey.reveal()}`,
            'Content-Type': 'application/json',
            // realtime §6: from our side. A client-supplied value is worthless for abuse
            // attribution, which is the only thing this header is for.
            'OpenAI-Safety-Identifier': deps.safetyIdentifier,
          },
          // The GA session shape, same as `session.update`. A top-level `voice` here carries the
          // same silent misconfiguration (realtime §3).
          body: JSON.stringify({
            session: {
              type: 'realtime',
              model: config.model,
              audio: { output: { voice: config.voice } },
            },
          }),
        });
      } catch {
        throw fault(
          'offline',
          'Could not reach the Realtime API to mint a session credential.',
          true,
        );
      }

      if (!response.ok) throw faultForStatus(response.status);

      // Deliberately not included in any message above or below: the response body. An auth
      // failure can echo request material, and these messages are destined for a log.
      return parseClientSecret(await response.text(), now);
    },
  };
}

function faultForStatus(status: number): VoiceFaultError {
  if (status === 401 || status === 403) {
    return fault(
      'auth',
      'The OpenAI API rejected the key. Check RIKI_OPENAI_API_KEY in your .env (REPO_SKELETON.md §7.1).',
      false,
    );
  }
  if (status === 429) {
    return fault('offline', 'Rate limited while minting a session credential.', true);
  }
  return fault('offline', `Could not mint a session credential (HTTP ${String(status)}).`, true);
}

/** Exported for the test, and because the response shape has moved once already. */
export function parseClientSecret(body: string, now: MonoMs): ClientSecret {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw fault('offline', 'The client-secret response was not JSON.', true);
  }

  const root =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const nested =
    typeof root.client_secret === 'object' && root.client_secret !== null
      ? (root.client_secret as Record<string, unknown>)
      : {};

  const value = typeof root.value === 'string' ? root.value : nested.value;
  if (typeof value !== 'string' || value === '') {
    throw fault('offline', 'The client-secret response carried no secret.', true);
  }

  const expiresAtSeconds = typeof root.expires_at === 'number' ? root.expires_at : null;
  const sessionId =
    typeof root.session_id === 'string'
      ? root.session_id
      : typeof nested.session_id === 'string'
        ? nested.session_id
        : '';

  return {
    value,
    expiresAt: (expiresAtSeconds === null
      ? now + DEFAULT_TTL_MS
      : expiresAtSeconds * 1000) as MonoMs,
    sessionId: sessionId as SessionId,
  };
}

/**
 * The renderer's view: it can ask for a credential and cannot ask for a key, because there is no
 * method that would return one. Implemented over the preload bridge.
 */
export interface CredentialPort {
  acquire(): Promise<ClientSecret>;
}
