/**
 * Token verification for the GSI endpoint.
 *
 * The endpoint binds loopback and accepts a POST from anything that can reach it, so the token is
 * the second and last line of defence (§4.1). Three properties, all of them load-bearing:
 *
 * - **Constant time.** `timingSafeEqual` rather than `===`. The attack is far-fetched — a local
 *   process guessing a per-install secret a byte at a time — but the fix costs one import, and a
 *   comparison that leaks is the kind of thing nobody revisits.
 * - **Never throws.** A malformed `auth` block is a verdict, not an exception: the HTTP layer has
 *   to answer 403 and move on, and an exception there becomes a 500 loop against a client that
 *   will keep POSTing regardless.
 * - **Never echoes the token**, in a return value, a log line or an error message.
 */

import { timingSafeEqual } from 'node:crypto';
import type { AuthVerdict, GsiAuthenticator } from './contracts.js';

export function createGsiAuthenticator(expected: string): GsiAuthenticator {
  const expectedBytes = Buffer.from(expected, 'utf8');

  return {
    verify(presented: string | undefined): AuthVerdict {
      if (presented === undefined || presented === '') return 'missing';

      const presentedBytes = Buffer.from(presented, 'utf8');
      // `timingSafeEqual` throws on a length mismatch, which would leak the length by exception
      // and defeat the point. Compare a fixed-length digest of each instead — same secret, same
      // digest, and a mismatched length is just another mismatched digest.
      if (presentedBytes.length !== expectedBytes.length) {
        // Still do a comparison of equal length so the refusal costs the same as an acceptance.
        timingSafeEqual(expectedBytes, expectedBytes);
        return 'mismatch';
      }

      return timingSafeEqual(presentedBytes, expectedBytes) ? 'ok' : 'mismatch';
    },
  };
}

/**
 * Pulls the token out of a POST body.
 *
 * Valve puts it at `auth.token`, which is inside the JSON rather than in a header — so the body
 * has to be parsed before the request can be authenticated, and a parse failure is therefore an
 * auth failure rather than a separate case.
 */
export function tokenFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const auth = (body as Record<string, unknown>).auth;
  if (typeof auth !== 'object' || auth === null) return undefined;
  const token = (auth as Record<string, unknown>).token;
  return typeof token === 'string' ? token : undefined;
}
