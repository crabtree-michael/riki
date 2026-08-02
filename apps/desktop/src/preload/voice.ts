/**
 * The voice window's preload entry.
 *
 * Separate from `index.ts` — the overlay's — because each window should see only the surface it
 * needs. The overlay must not be able to open a session; the voice window must not be able to
 * dispatch an overlay intent. Two entries is how that is enforced rather than remembered.
 */

import { exposeVoiceBridge } from './voice-bridge.js';

export * from './voice-bridge.js';

exposeVoiceBridge();
