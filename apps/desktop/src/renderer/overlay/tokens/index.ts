/**
 * Token *names*. The values are in tokens.css and stay there — see the header of that file for
 * why this module cannot hold them (docs/design/overlay-architecture.md §7.5).
 */

import type { AccentToken } from '../../../shared/overlay.js';
import type { ChipToken, TokenModule } from '../contracts.js';

/** Set on the root element when the user asks for the high-contrast variant. */
export const HIGH_CONTRAST_CLASS = 'riki-contrast-high';

const ACCENT_VARIABLES: Readonly<Record<AccentToken, string>> = {
  listening: '--riki-accent-listening',
  working: '--riki-accent-working',
  speaking: '--riki-accent-speaking',
  error: '--riki-accent-error',
  muted: '--riki-accent-muted',
};

const CHIP_VARIABLES: Readonly<Record<ChipToken, string>> = {
  bg: '--riki-chip-bg',
  border: '--riki-chip-border',
  shadow: '--riki-chip-shadow',
};

export function cssVariable(token: AccentToken | ChipToken): string {
  return token in ACCENT_VARIABLES
    ? ACCENT_VARIABLES[token as AccentToken]
    : CHIP_VARIABLES[token as ChipToken];
}

export function createTokenModule(root: HTMLElement): TokenModule {
  return {
    cssVariable,
    contrastVariant: () => (root.classList.contains(HIGH_CONTRAST_CLASS) ? 'high' : 'normal'),
  };
}
