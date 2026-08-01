/**
 * `VoiceEvent` → `MachineInput`, and `VoiceCommand` back the other way.
 *
 * The translation table, which is the entire point of this file existing:
 *
 * | `VoiceEvent` | `MachineInput` | Note |
 * |---|---|---|
 * | `capture` opened/firstAudio/closed | `capture` | 1:1 |
 * | `speech` silence/resumed | `speech` | 1:1 |
 * | `turn` submitted | `turn` | Server VAD can end a turn with the key still held (ADR-0017) |
 * | `turn` responseStarted, machine Idle | **`unprompted` speechStarted** | §9.3 — the primary path |
 * | `turn` responseStarted, otherwise | `turn` | The answer to something the player asked |
 * | `turn` responseEnded | `turn` | |
 * | `fault` | `fault` | Identity: the two kind unions are spelled the same — see the case |
 * | `command` mute | `mute` | `quiet-mode` is **not** here — see below |
 * | `level` | — | Rides its own channel to the presenter, never through the reducer (§6.1) |
 * | `transcript` | — | Captions are the presenter's, and default off (ui-design §9.3) |
 * | `cost` | — | Telemetry, not a state |
 *
 * **`quiet-mode` is deliberately absent.** It is the off switch for unprompted speech
 * (`coaching-architecture.md` §7.1) and it is handled by the composition root, which flips
 * `EventEngine.setQuietMode`. The chip's `muted` is a different thing — it suppresses *gestures*
 * too — and mapping one onto the other would mean saying "only when I ask" also stopped
 * push-to-talk working, which is the opposite of what the player asked for.
 */

import type { VoiceEvent } from '@riki/realtime';
import type { Unsubscribe } from '../../shared/overlay.js';
import type { VoiceCommandSink } from '../session/contracts.js';
import type { MachineInput } from '../session/types.js';
import type {
  PhaseReader,
  VoiceBridge,
  VoiceCommandTarget,
  VoiceEventSource,
} from './contracts.js';

export interface VoiceBridgeDeps {
  readonly phase: PhaseReader;
  /** Level frames bypass the reducer entirely; the presenter takes them straight. */
  readonly pushLevel?: (source: 'input' | 'output', value: number, at: number) => void;
  readonly onCost?: (usd: number, turns: number) => void;
}

export function createVoiceBridge(deps: VoiceBridgeDeps): VoiceBridge {
  return {
    attach(source: VoiceEventSource, sink: (input: MachineInput) => void): Unsubscribe {
      return source.onEvent((event: VoiceEvent) => {
        switch (event.kind) {
          case 'capture':
            sink({ kind: 'capture', event: event.event });
            return;

          case 'speech':
            sink({ kind: 'speech', event: event.event });
            return;

          case 'turn':
            if (event.event === 'responseStarted' && deps.phase.phase() === 'idle') {
              // No gesture behind it. Skipping Armed and the earcon is §9.3, and the machine
              // ignores `turn.responseStarted` while Idle precisely so this branch has to be
              // taken deliberately rather than by accident.
              sink({ kind: 'unprompted', event: 'speechStarted' });
              return;
            }
            sink({ kind: 'turn', event: event.event });
            return;

          case 'fault':
            // The two fault unions are not independent: `VoiceFaultKind` is exactly the machine's
            // `FaultKind` minus `no-speech-detected`, spelled identically, so this is the identity
            // and there is no table. `no-speech-detected` has no producer here because it is not a
            // session failure — it is the machine's own listen-timeout expiring. If the two ever
            // diverge, this is the line that becomes a table, and the compiler will say so.
            sink({
              kind: 'fault',
              fault: {
                kind: event.fault.kind,
                message: event.fault.message,
                persistent: event.fault.persistent,
              },
            });
            return;

          case 'command':
            if (event.command === 'mute') sink({ kind: 'mute', muted: true });
            return;

          case 'level':
            deps.pushLevel?.(event.source, event.value, event.at);
            return;

          case 'cost':
            deps.onCost?.(event.usd, event.turns);
            return;

          case 'transcript':
            return;
        }
      });
    },

    commands(target: VoiceCommandTarget): VoiceCommandSink {
      return {
        send(command): void {
          // `interrupt` carries the moment the player interrupted rather than the moment we got
          // round to it: that difference is milliseconds of audio the model would otherwise
          // believe were heard, and it is what `conversation.item.truncate` needs to be right.
          target.send(
            command.kind === 'interrupt'
              ? { kind: 'interrupt', at: command.at as never }
              : { kind: 'abort' },
          );
        },
      };
    },
  };
}
