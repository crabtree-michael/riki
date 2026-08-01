/**
 * Turning a handler's structure into the ~40 tokens the model is told.
 *
 * The rules here are the snapshot's rules (dota2 §6.2), and they are not restated so much as
 * **reused** — `../render/` holds the three primitives and both tiers compose them, which is the
 * main reason Tier 2 and Tier 3 live in the same package. What this module adds is the Tier 3
 * shape: a list of labelled parts, each of which may vanish, under a per-command ceiling.
 *
 * Four rules, all inherited:
 *
 * - **A stale fact renders with its age and confidence or it does not render.** Handlers return
 *   `Observed<T>`, so a bare value is not available to render even by mistake.
 * - **Below-threshold facts are dropped, not hedged.** Hedging spends tokens to say nothing.
 * - **Truncation is priority-ordered and recorded**, so a golden test can assert *what* survived a
 *   tight budget — a design decision rather than an accident.
 * - **Privacy is a render input**, and it is the second of two independent gates on chat text.
 *
 * See docs/design/agent-command-execution-architecture.md §4.6.
 */

import type { GameClock, MonoMs, Observed, PrivacyPolicy } from '../common/types.js';
import type { FieldPath } from '../common/ports.js';
import type { RenderContext, RenderedResult } from './types.js';
import type { AgeFormatter, PrivacyGate } from '../render/contracts.js';
import type { Section, SectionId } from '../render/types.js';
import { createAgeFormatter, renderObserved } from '../render/age.js';
import { classifyField, createPrivacyGate } from '../render/privacy.js';
import { createSectionComposer } from '../render/compose.js';
import { estimateTokens } from '../render/tokens.js';

const composer = createSectionComposer();
const gate: PrivacyGate = createPrivacyGate();

/**
 * One line of a result.
 *
 * `text: null` is a part that was **dropped** — below the confidence floor, or refused by the
 * privacy gate — and it lands in `omitted` rather than becoming an empty line. The distinction is
 * the difference between "sf: " and no mention of sf at all, and only one of those is honest.
 */
export interface Part {
  readonly id: string;
  /** Lower drops first, from the declared ladder rather than from statement order. */
  readonly priority: number;
  readonly droppable?: boolean;
  readonly text: string | null;
}

export function compose(parts: readonly Part[], ctx: RenderContext): RenderedResult {
  const omitted: string[] = [];
  const sections: Section[] = [];

  for (const part of parts) {
    if (part.text === null || part.text === '') {
      omitted.push(part.id);
      continue;
    }
    sections.push({
      id: part.id as SectionId,
      priority: part.priority,
      droppable: part.droppable ?? true,
      body: { text: part.text, tokens: estimateTokens(part.text) },
    });
  }

  const composed = composer.compose(sections, { maxTokens: ctx.maxTokens, spentTokens: 0 });

  return {
    text: composed.text,
    tokens: composed.tokens,
    truncated: composed.truncated,
    omitted: [...omitted, ...composed.omitted.map(String)],
  };
}

/** The formatter every Tier 3 renderer uses. One instance, so one confidence floor. */
export function formatterFor(confidenceFloor: number): AgeFormatter {
  return createAgeFormatter({ confidenceFloor, unseenAfterMs: 20_000 });
}

const defaultFormatter = createAgeFormatter();

/** `label value 4s ago(0.91)`, or `null` if the fact did not survive the confidence gate. */
export function field(
  label: string,
  observed: Observed<unknown> | undefined,
  ctx: RenderContext,
  format?: (value: unknown) => string,
): string | null {
  if (observed === undefined) return null;
  return renderObserved(label, observed, defaultFormatter, ctx.now, ctx.clock, format);
}

/**
 * The privacy gate, applied by field path.
 *
 * `get_recent_events` is the command that would otherwise carry other players' words into a
 * third-party API, and this is where it does not. Default off, asserted by the egress test in
 * `tools.egress.test.ts` — which is the test that cannot be walked back once it has failed in
 * production, and is cheap.
 */
export function allowedByPrivacy(path: FieldPath, policy: PrivacyPolicy): boolean {
  return gate.allow(classifyField(path), policy);
}

export function redactText(text: string, policy: PrivacyPolicy): string {
  return gate.redact(text, policy);
}

/** Seconds, the way a coach says them: `4s`, `1m20`. */
export function duration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${String(whole)}s`;
  return `${String(Math.floor(whole / 60))}m${String(whole % 60).padStart(2, '0')}`;
}

/** A game clock as `mm:ss`, negative before the horn. */
export function clockText(clock: GameClock | null): string {
  if (clock === null) return 'pre-horn';
  const sign = clock < 0 ? '-' : '';
  const abs = Math.abs(Math.round(clock));
  return `${sign}${String(Math.floor(abs / 60))}:${String(abs % 60).padStart(2, '0')}`;
}

/** Both tiers age from the same `now`; re-exported so a handler never reaches for a clock. */
export type { MonoMs };
