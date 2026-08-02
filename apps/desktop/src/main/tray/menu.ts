/**
 * The tray menu, as a value.
 *
 * Pure, for the same reason the interaction machine is: the menu is a projection of state, and a
 * projection that can only be inspected by clicking a real tray icon on a real desktop is a
 * projection nobody will ever assert anything about. `electron-tray.ts` turns this into a
 * `Menu.buildFromTemplate` call and does nothing else.
 *
 * ui-design.md §2.3 draws the full menu. Four of its rows are **not here**, and their absence is
 * deliberate rather than an oversight:
 *
 * | Row | Why it is absent |
 * |---|---|
 * | Overlay position ▸ | `PlacementResolver` exists but nothing persists a choice — that is `@riki/config` |
 * | Input device ▸ | The device list lives in the voice renderer, which does not exist yet |
 * | Per-game profiles… | No settings surface, and no second game |
 * | Settings… | `src/renderer/settings/` is empty |
 *
 * A menu item that opens nothing is worse than a missing one: it reads as a bug on first click
 * and as a broken product on the second. They come back with the surfaces they need.
 */

import type { CoachMode } from '@riki/config';
import type { TrayGlyph } from '../../shared/overlay.js';

export type { CoachMode };

export type TrayAction = 'toggle-mute' | 'toggle-coach' | 'quit';

export interface TrayMenuItem {
  readonly kind: 'action' | 'label' | 'separator';
  readonly id?: TrayAction;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly accelerator?: string;
}

export interface TrayModel {
  readonly glyph: TrayGlyph;
  readonly muted: boolean;
  /** One line, from the state subsystem's health. Never a token, a path or chat text. */
  readonly status: string;
  /**
   * Which coach is running, and whether the other one can be reached from here.
   *
   * `available: false` is the no-key case, and the row is rendered **disabled with its reason in the
   * label** rather than hidden. That is the opposite of this file's rule about the four absent rows
   * — but those open a surface that does not exist, and this one describes a state the app is
   * actually in. This row *is* the mode switch (ADR-0031), so a player who clicks it and gets the
   * static coach anyway needs to be told why, and the tray is the only place Riki can tell them.
   */
  readonly coach: { readonly mode: CoachMode; readonly available: boolean };
}

/** ui-design.md §2.3. `⌥⌘M` on macOS, the primary target; Electron maps `Alt+Command` per platform. */
export const MUTE_ACCELERATOR = 'Alt+Command+M';

export function projectMenu(model: TrayModel): readonly TrayMenuItem[] {
  return [
    { kind: 'label', label: `Riki — ${model.status}`, enabled: false },
    { kind: 'separator' },
    {
      kind: 'action',
      id: 'toggle-mute',
      label: 'Mute Riki',
      checked: model.muted,
      enabled: true,
      accelerator: MUTE_ACCELERATOR,
    },
    { kind: 'separator' },
    coachRow(model.coach),
    { kind: 'separator' },
    { kind: 'action', id: 'quit', label: 'Quit Riki', enabled: true },
  ];
}

/**
 * The coach toggle — requirement 1's runtime switch, as the one surface a player can reach.
 *
 * A checkbox rather than a submenu: there are two coaches and there is not going to be a third, so a
 * two-item radio group would be two rows saying what one checkbox says. `checked` is *"the LLM coach
 * is on"*, which makes the unchecked state the deterministic default and reads correctly to somebody
 * who has never heard of either.
 */
export function coachRow(coach: TrayModel['coach']): TrayMenuItem {
  if (!coach.available) {
    return {
      kind: 'action',
      id: 'toggle-coach',
      label: 'LLM coach — needs RIKI_OPENAI_API_KEY',
      checked: false,
      enabled: false,
    };
  }
  return {
    kind: 'action',
    id: 'toggle-coach',
    label: 'LLM coach',
    checked: coach.mode === 'llm',
    enabled: true,
  };
}

/**
 * The tooltip, which on macOS is the only text a user sees without opening the menu.
 *
 * `attention` is the one glyph that means *something needs you*, so it says what rather than
 * repeating the glyph's name — the status line is already the health summary, and a tooltip
 * reading "attention" would be the third place to say nothing useful.
 */
export function projectTooltip(model: TrayModel): string {
  switch (model.glyph) {
    case 'muted':
      return 'Riki — muted';
    case 'attention':
      return `Riki — ${model.status}`;
    case 'active':
      return 'Riki — in a session';
    case 'idle':
      return `Riki — ${model.status}`;
  }
}
