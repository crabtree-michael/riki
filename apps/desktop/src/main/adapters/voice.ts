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
 * | `turn` responseStarted / responseEnded | `turn` | The answer to something the player asked |
 * | `fault` | `fault` | Identity: the two kind unions are spelled the same — see the case |
 * | `command` mute | `mute` | |
 * | `command` stop / cancel | `trigger` cancel | One producer for "stop talking" — see below |
 * | `command` quiet-mode | — | Nothing left to switch off — see below |
 * | `level` | — | Rides its own channel to the presenter, never through the reducer (§6.1) |
 * | `transcript` | — | Captions are the presenter's, and default off (ui-design §9.3) |
 * | `cost` | — | Telemetry, not a state |
 *
 * Two rows moved with ADR-0042 and both are worth a sentence.
 *
 * **`responseStarted` while Idle used to be a different input.** It meant the chip appearing with
 * no gesture behind it, which was how a coaching turn became visible. With no coaching turns a
 * response with no phase behind it is not a state to render, so it takes the ordinary `turn` input
 * and the machine ignores it from Idle.
 *
 * **`stop` and `cancel` now go through the machine rather than straight at the session.** The
 * coaching agent used to call `session.abort()` for them from its own subscription, which meant the
 * audio stopped and the chip did not. Routing them as a `cancel` trigger gives "stop talking" the
 * single producer the Esc key and the overlay's cancel intent already share, and the abort still
 * reaches the session — as the machine's own `voice` effect.
 *
 * **`quiet-mode` reaches nothing, deliberately.** "Only when I ask" was the off switch for
 * unprompted speech, and it is now what Riki does unconditionally. The phrase stays in
 * `packages/realtime`'s parser, where a player who says it is answered by the product's behaviour
 * rather than by a setting.
 */

import type { VoiceEvent } from '@riki/realtime';
import type { Unsubscribe } from '../../shared/overlay.js';
import type { VoiceCommandSink } from '../session/contracts.js';
import type { MachineInput } from '../session/types.js';
import type { VoiceBridge, VoiceCommandTarget, VoiceEventSource } from './contracts.js';

export interface VoiceBridgeDeps {
  /** Level frames bypass the reducer entirely; the presenter takes them straight. */
  readonly pushLevel?: (source: 'input' | 'output', value: number, at: number) => void;
  readonly onCost?: (usd: number, turns: number) => void;
}

export function createVoiceBridge(deps: VoiceBridgeDeps = {}): VoiceBridge {
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
            // The machine turns this into an `abort` effect, which the composition root sends at
            // the session. See the header: one producer, and the chip agrees with the audio.
            if (event.command === 'stop' || event.command === 'cancel') {
              sink({ kind: 'trigger', event: { kind: 'cancel' } });
            }
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
