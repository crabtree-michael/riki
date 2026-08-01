/**
 * Wire constants.
 *
 * `REALTIME_SAMPLE_RATE` is re-exported from `@riki/audio` rather than redeclared. It is one
 * number, but it is the number that both packages have to agree on — PCM only supports 24 kHz
 * (openai-realtime-research.md §3) — and two copies of a rate that must match is precisely how
 * you end up with the pitch-shifted audio that §3 warns produces no error at all.
 */

export { REALTIME_SAMPLE_RATE } from '@riki/audio';

/** The data channel's name is fixed by the API; anything else fails the SDP negotiation (§2). */
export const OAI_EVENT_CHANNEL = 'oai-events';

export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
export const REALTIME_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
export const REALTIME_WEBSOCKET_URL = 'wss://api.openai.com/v1/realtime';
