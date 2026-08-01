/**
 * `packages/gsi` and `packages/log-tail` as supervised sources.
 *
 * Both packages mirror `ObservationSource` locally rather than importing `packages/world-model`
 * (ADR-0014 — sources and the model meet at a type, never at each other), so the three copies are
 * structurally identical and this file is where they are declared to be. The adapters are
 * one-liners on purpose: if one of them ever needs to *do* something, the mirrored types have
 * drifted and the fix belongs in the protocol package, not here.
 *
 * `RestartPolicy` is `NO_RESTART` for both, which looks wrong until you ask what restarting would
 * mean. Neither exits. They fail by going quiet — Dota is closed, the player is in the main menu,
 * the console log has not been written since the last match — and a quiet source is not a broken
 * one. Rebinding a healthy HTTP listener because nobody has POSTed for a minute would close the
 * socket Dota is about to use. §8.1's "GSI and log-tail restart on configuration change" is a
 * statement about the shell rebuilding them, not about the supervisor retrying.
 */

import type { GsiServerWithExtras } from '@riki/gsi';
import type { ConsoleLogTailer } from '@riki/log-tail';
import type { Observation, SourceHealth } from '@riki/world-model';
import type { SourceRegistration } from './index.js';
import { NO_RESTART } from './contracts.js';

export function gsiRegistration(server: GsiServerWithExtras): SourceRegistration {
  return {
    policy: NO_RESTART,
    source: {
      id: server.id,
      start: () => server.start(),
      stop: () => server.stop(),
      subscribe: (listener: (o: Observation) => void) => server.subscribe(listener),
      health: (now): SourceHealth => server.health(now),
    },
    // The only source that sees `match_id`, and therefore the only one that can produce the
    // lifecycle edges §6.4's table is keyed on.
    lifecycle: (listener) => server.onLifecycle(listener),
  };
}

export function logTailRegistration(tailer: ConsoleLogTailer): SourceRegistration {
  return {
    policy: NO_RESTART,
    source: {
      id: tailer.id,
      start: () => tailer.start(),
      stop: () => tailer.stop(),
      subscribe: (listener: (o: Observation) => void) => tailer.subscribe(listener),
      health: (now): SourceHealth => tailer.health(now),
    },
  };
}
