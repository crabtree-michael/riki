/**
 * The API key, and the ephemeral secret that keeps it out of the renderer.
 *
 * REPO_SKELETON.md §7.1 sets the rules this file exists to satisfy: the key is read in exactly
 * one place (`packages/config`, in the Electron **main** process), **injected** into this
 * package, and never crossing the preload bridge. A lint boundary makes `process.env`
 * unreadable here, and §5.4 asks for a test asserting `packages/realtime` receives the key
 * injected and never reads the environment itself.
 *
 * The ephemeral-secret split is the second half, and it follows from ADR-0010. The voice window
 * is a renderer: it owns `getUserMedia` and the peer connection, so it needs *a* credential — but
 * research §2 and §9 are unambiguous that it must not be the real key. So:
 *
 *   main process (has the key) ──mint──► ephemeral client secret ──► voice window ──► WebRTC
 *
 * `ApiKey` is a class rather than a string for one reason, and it is worth the ceremony: it
 * stringifies to `[redacted]`. An accidental `JSON.stringify(deps)` in a telemetry call or a
 * template literal in an error message is the realistic way a key reaches a log, and neither is
 * caught by a lint rule.
 */

import { REALTIME_CLIENT_SECRETS_URL } from '../protocol/constants.js';
import type { Millis, RealtimeModel, RealtimeVoice } from '../types.js';

const REDACTED = '[redacted]';

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

  /** Node's `console.log`/`util.inspect` path — the one `toString` does not cover. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

export interface EphemeralCredentials {
  /** Short-lived. Safe to hand to a renderer; useless to anyone who scrapes it an hour later. */
  readonly clientSecret: string;
  readonly expiresAt: Millis;
}

/** Structural, so this package needs neither DOM types nor a fetch polyfill to be tested. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<FetchResponseLike>;

export interface MinterDeps {
  readonly apiKey: ApiKey;
  readonly fetch: FetchLike;
  /**
   * §6: a stable hashed user ID **from our side**. A client-supplied value is worthless for abuse
   * attribution, which is the only thing this header is for.
   */
  readonly safetyIdentifier: string;
  readonly now: () => Millis;
}

export interface MintRequest {
  readonly model: RealtimeModel;
  readonly voice: RealtimeVoice;
}

/** §12: "Ephemeral tokens still need rate limiting", or the mint path becomes the abuse vector. */
export const MIN_MINT_INTERVAL_MS = 1_000;

export class EphemeralSecretMinter {
  readonly #deps: MinterDeps;
  #lastMintAt: Millis | null = null;

  constructor(deps: MinterDeps) {
    this.#deps = deps;
  }

  async mint(request: MintRequest): Promise<EphemeralCredentials> {
    const now = this.#deps.now();
    if (this.#lastMintAt !== null && now - this.#lastMintAt < MIN_MINT_INTERVAL_MS) {
      throw new Error('Refusing to mint a client secret more than once per second.');
    }
    this.#lastMintAt = now;

    const response = await this.#deps.fetch(REALTIME_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#deps.apiKey.reveal()}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': this.#deps.safetyIdentifier,
      },
      // The GA session shape, same as `session.update` — a top-level `voice` here is the beta
      // schema and carries the same silent misconfiguration (research §3).
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: request.model,
          audio: { output: { voice: request.voice } },
        },
      }),
    });

    if (!response.ok) {
      // Deliberately does not include the response body: an auth failure from OpenAI can echo
      // request material, and this message is destined for a log.
      throw new Error(`Could not mint a Realtime client secret (HTTP ${String(response.status)}).`);
    }

    return parseClientSecret(await response.text(), now);
  }
}

export function parseClientSecret(body: string, now: Millis): EphemeralCredentials {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('The client-secret response was not JSON.');
  }

  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  // The API has returned this under both `value` and a nested `client_secret.value`.
  const nested =
    typeof record.client_secret === 'object' && record.client_secret !== null
      ? (record.client_secret as Record<string, unknown>)
      : {};

  const secret = typeof record.value === 'string' ? record.value : nested.value;
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('The client-secret response carried no secret.');
  }

  const expiresAt = typeof record.expires_at === 'number' ? record.expires_at * 1000 : null;
  return { clientSecret: secret, expiresAt: expiresAt ?? now + 60_000 };
}
