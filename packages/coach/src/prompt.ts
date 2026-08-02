/**
 * What the coach is told, and how a moment is written down for it.
 *
 * Both halves are pure and both are golden-tested (`fixtures/golden/coach/`), for the same reason
 * the snapshot renderer is: **this is the interface to the model**, so a change to it is an API
 * change and the diff is the review. A tweak to one sentence of `INSTRUCTIONS` can move the
 * speak-rate of the whole product, and a silent one is the failure mode this product cannot see.
 *
 * The instructions do **not** contain Riki's persona. The persona lives in the Realtime session
 * preamble and shapes how the voice sounds; this agent decides *whether* and *what*, and giving it
 * a second, drifting copy of the voice would produce a coach that argues with itself about tone.
 * What it does carry is the product promise, because that is a judgement instruction rather than a
 * style one: **invisible until needed**.
 *
 * See docs/design/llm-coach-architecture.md §5.
 */

import type { CoachSignal, CoachStimulus, SpokenNote } from './types.js';

/**
 * The agent's standing instructions.
 *
 * Written against requirement 2: this model is not bound by the thirteen gates, so everything those
 * gates encoded has to be *argued* here instead of enforced. That is the trade, stated plainly —
 * a cooldown is a guarantee and a paragraph is a tendency, and the paragraph is what buys the
 * ability to notice something no detector was written for.
 *
 * Five things it must get right, in the order they matter:
 *
 * 1. Silence is the default and the expected answer.
 * 2. Never state a stale fact as certain — the world text carries ages and confidences.
 * 3. Do not repeat yourself unless the situation moved.
 * 4. One or two sentences, speakable, second person.
 * 5. Say nothing that requires a number the world text does not contain.
 */
export const INSTRUCTIONS = `You are the judgement behind Riki, a voice coach that watches a live \
Dota 2 match over the player's shoulder. You do not talk to the player. You decide, moment by \
moment, whether Riki should say anything at all — and if so, what.

Riki's product promise is that it is invisible until needed. The overwhelmingly common correct \
answer is speak: false. A coach who comments on everything is uninstalled within one match; a coach \
who says one genuinely useful thing every few minutes is worth keeping. Assume the player is a \
competent ranked player who can see their own screen. They do not need to be told what is already \
in front of them.

You are consulted when a detector reports something that has just become true. There is no timer \
and no periodic check-in: if nothing new happens, you are not asked. So every consultation has at \
least one signal behind it, and that signal is what you may speak about.

WHAT YOU ARE GIVEN

The world is rendered as short lines of observed state. Every observed value carries its age and \
its confidence, and some values are marked unseen or stale. This is the single most important thing \
about your input: Riki does not have a live feed of the enemy team. A position from thirty seconds \
ago is a guess about the present.

- Never state a stale value as if it were current. Say "was bottom thirty seconds ago", not "is \
bottom".
- If the thing you want to say depends on a fact you do not have, do not say it. Do not infer a \
number that is not in front of you, and never invent gold, timers, cooldowns or item counts.
- Signals are conditions a detector believes are true right now, with a magnitude and a confidence. \
A signal is a reason to look, not an instruction to speak.

WHAT YOU DECIDE

You are not on a cooldown and there is no rule stopping you. Nothing is filtered after you: if you \
say speak: true, the player hears it. Judge it yourself:

- Is this actionable in the next thirty seconds? Advice that arrives after the moment is worse than \
silence, because it costs attention and returns nothing.
- Is it something they plausibly have not noticed? Their own health bar is not.
- Did you already say it? You are shown what you have said this match, and how long ago. Repeating \
yourself is the fastest way to become noise. Say it again only if the situation has materially \
changed, and if you do, acknowledge that it is still true rather than announcing it as new.
- Is the player in the middle of something? If a fight is clearly underway, either say the one \
thing that changes it in under two seconds, or stay out of the way.

HOW TO SAY IT

- One or two short sentences. This is spoken aloud over a game.
- Second person, present tense, no preamble, no sign-off, no filler.
- Concrete. "Their Spectre has no buyback for another minute — take Roshan now" beats "consider \
objectives".
- No lists, no markdown, no numbers you cannot support from the world text.

YOUR TOOL

lookup_hero gives you static coaching notes about a hero — what it does, when it spikes, how to play \
against it. It is patch-stamped and it holds shape rather than numbers, so it is durable and it is \
never about this match. Use it when the thing you want to say depends on what a hero usually does, \
and not otherwise. It covers twenty heroes; most are not in it, and a hero it does not cover is not \
a reason to stay quiet.

YOUR ANSWER

Always fill in reasoning, in one sentence, whether or not you speak. When you stay quiet it is the \
only record of why, and it is what the people tuning this coach read.

When you speak, set about to the key of the signal you are speaking about — the exact string in \
square brackets at the start of its line, such as enemy_missing:sf. Copy it; do not paraphrase it \
and do not invent one. A key that was not in the list you were shown is thrown away and Riki says \
nothing, because Riki's record of what it advised is built from that key. If what you want to say \
is not about any of the signals you were given, say nothing this time.

weight is your own view of how much this mattered, 0 to 1. Nothing compares it to a threshold; you \
have already decided by setting speak.`;

// -----------------------------------------------------------------------------------------------
// Rendering a stimulus (§5.2)
// -----------------------------------------------------------------------------------------------

/**
 * Seconds as a coach would say them.
 *
 * A local copy of a formatter `packages/context` also has, and the duplication is deliberate: the
 * alternative is exporting a rendering helper across a package boundary so that two documents with
 * different audiences can share five lines of arithmetic. If a third caller appears, it belongs in
 * `@riki/protocol` with the rest of the shared vocabulary rather than in either package.
 */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  return `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, '0')}s ago`;
}

/**
 * The **key** leads the line, because it is the one token the model has to copy back verbatim.
 *
 * `about` is a `DetectionKey` and a judgement naming one the stimulus did not list is discarded
 * (`coach.ts`, the ADR-0013 invariant). So the key is rendered first, in brackets, rather than left
 * to be inferred from the kind — `enemy_missing:sf` and `enemy_missing:puck` are two moments, and a
 * model shown only `enemy_missing` twice cannot tell us which one it meant.
 */
function signalLine(signal: CoachSignal): string {
  const parts = [
    `magnitude ${signal.magnitude.toFixed(2)}`,
    `confidence ${signal.confidence.toFixed(2)}`,
  ];
  if (signal.actWithinSeconds !== null) {
    parts.push(`actionable for ${String(Math.round(signal.actWithinSeconds))}s`);
  }
  // `new` and not `fresh`: the model is being told a fact about the world, and "new" is the word a
  // person uses for it. The field is named `fresh` because `new` is a reserved word.
  const flag = signal.fresh ? 'new ' : '';
  return `- [${signal.key}] ${flag}${signal.text} (${parts.join(', ')})`;
}

function spokenLine(note: SpokenNote, now: number): string {
  return `- ${ago(now - note.at)} [${note.kind}] "${note.text}"`;
}

/**
 * The stimulus, as the one user message of a one-shot run.
 *
 * There is no conversation across consultations — every judgement is a fresh call whose whole
 * context is this string plus `INSTRUCTIONS`. That is what stops a forty-minute match becoming a
 * forty-minute prompt, and it is why `already said` is a rendered section here rather than prior
 * turns in a thread: the coach's memory is a value we control and can cap, not a window that
 * truncates oldest-first out from under us (ADR-0012's argument, applied one layer up).
 *
 * Sections are omitted rather than rendered empty, which is the same rule every renderer in this
 * repo holds: an absent `signals` block and an empty one say different things.
 */
export function renderStimulus(stimulus: CoachStimulus): string {
  const blocks: string[] = [];

  // The deadline is rendered as well as enforced, and showing it is the point: a model that knows
  // it has five seconds can skip the library lookup and answer, where one that does not will spend
  // the window on a tool call and have its answer thrown away as overtaken (`coach.ts`).
  if (stimulus.actWithinSeconds !== null) {
    blocks.push(
      `this is worth saying for about ${String(Math.round(stimulus.actWithinSeconds))}s. ` +
        'Answer inside that if you can; a late line is checked against the world before it is spoken.',
    );
  }

  if (stimulus.secondsSinceSpoke === null) {
    blocks.push('you have not spoken yet this match.');
  } else {
    blocks.push(`you last spoke ${String(Math.round(stimulus.secondsSinceSpoke))}s ago.`);
  }

  blocks.push(`world:\n${stimulus.world}`);

  if (stimulus.signals.length > 0) {
    blocks.push(`signals:\n${stimulus.signals.map(signalLine).join('\n')}`);
  }

  if (stimulus.spoken.length > 0) {
    blocks.push(
      `already said this match, oldest first:\n${stimulus.spoken
        .map((note) => spokenLine(note, stimulus.at))
        .join('\n')}`,
    );
  }

  return blocks.join('\n\n');
}
