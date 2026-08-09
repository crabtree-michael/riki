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
 *
 * A fifth row *was* here and is gone rather than pending: the LLM-coach checkbox (ADR-0031). It was
 * the one surface for choosing between two coaches, and ADR-0042 deleted both — there is nothing
 * left for it to switch between, and a checkbox describing a state the app can no longer be in is
 * the same mistake as one that opens nothing.
 */

import type { TrayGlyph } from '../../shared/overlay.js';

export type TrayAction = 'toggle-mute' | 'open-debug' | 'quit';

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
   * Whether the inspector row is offered — `config.debug.enabled`, and false by default.
   *
   * The one absent row to earn its way back, and it earns it on this file's own argument: it opens
   * a real window (`main/debug/`). It stays conditional because a debug row in a shipped build is
   * the same mistake in a different direction — an affordance most people should never see, and one
   * that costs something to keep armed (`shell/config.ts`'s `DebugConfig`).
   */
  readonly debug: boolean;
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
    // Last before Quit: this is a developer affordance and the rows above it are the product.
    ...(model.debug
      ? ([
          { kind: 'separator' },
          { kind: 'action', id: 'open-debug', label: 'Open Inspector…', enabled: true },
        ] as const)
      : []),
    { kind: 'separator' },
    { kind: 'action', id: 'quit', label: 'Quit Riki', enabled: true },
  ];
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
