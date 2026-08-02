/**
 * The tray, without a desktop.
 *
 * The projection is pure so that "what does the menu say when Riki is muted" is an assertion
 * rather than a screenshot, and the controller is tested against a recording surface so the
 * *coalescing* — no re-render when nothing changed — is visible too. That one matters more than it
 * looks: `render` rebuilds an Electron `Menu` and reloads a `NativeImage`, and the status line is
 * pushed on a 2 s poll that mostly reports the same string.
 */

import { describe, expect, it } from 'vitest';
import type { TrayGlyph, Unsubscribe } from '../../shared/overlay.js';
import { MUTE_ACCELERATOR, projectMenu, projectTooltip } from './menu.js';
import type { TrayAction, TrayMenuItem } from './menu.js';
import { createTrayController, type TraySurface } from './index.js';

interface Rendered {
  readonly glyph: TrayGlyph;
  readonly tooltip: string;
  readonly menu: readonly TrayMenuItem[];
}

interface RecordingSurface extends TraySurface {
  readonly renders: readonly Rendered[];
  readonly last: Rendered;
  choose(action: TrayAction): void;
  readonly destroyed: boolean;
}

function recordingSurface(): RecordingSurface {
  const renders: Rendered[] = [];
  const actions = new Set<(action: TrayAction) => void>();
  let destroyed = false;

  return {
    renders,
    get last(): Rendered {
      const entry = renders[renders.length - 1];
      if (entry === undefined) throw new Error('nothing rendered');
      return entry;
    },
    get destroyed() {
      return destroyed;
    },
    render(glyph, tooltip, menu) {
      renders.push({ glyph, tooltip, menu });
    },
    onAction(listener): Unsubscribe {
      actions.add(listener);
      return () => actions.delete(listener);
    },
    destroy() {
      destroyed = true;
    },
    choose(action) {
      for (const listener of [...actions]) listener(action);
    },
  };
}

describe('the menu projection (ui-design.md §2.3)', () => {
  it('leads with a non-interactive status line', () => {
    const [first] = projectMenu({ glyph: 'idle', muted: false, status: 'ready' });
    expect(first).toEqual({ kind: 'label', label: 'Riki — ready', enabled: false });
  });

  it('carries the mute row as a checkbox with its accelerator', () => {
    const mute = projectMenu({ glyph: 'muted', muted: true, status: 'muted' }).find(
      (item) => item.id === 'toggle-mute',
    );
    expect(mute?.checked).toBe(true);
    expect(mute?.accelerator).toBe(MUTE_ACCELERATOR);
  });

  it('offers exactly the actions that go somewhere', () => {
    const ids = projectMenu({ glyph: 'idle', muted: false, status: 'ready' })
      .filter((item) => item.kind === 'action')
      .map((item) => item.id);
    // A menu item that opens nothing reads as a bug on first click; the four deferred rows come
    // back with the surfaces they need.
    expect(ids).toEqual(['toggle-mute', 'quit']);
  });

  it('says what is wrong in the tooltip when the glyph is `attention`', () => {
    expect(projectTooltip({ glyph: 'attention', muted: false, status: 'no microphone' })).toBe(
      'Riki — no microphone',
    );
  });
});

describe('the controller', () => {
  it('renders once at construction, so the icon exists before anything happens', () => {
    const surface = recordingSurface();
    createTrayController(surface);
    expect(surface.renders).toHaveLength(1);
  });

  it('does not re-render when nothing changed', () => {
    const surface = recordingSurface();
    const tray = createTrayController(surface);

    tray.setStatus('Watching the game.');
    tray.setStatus('Watching the game.');
    tray.setStatus('Watching the game.');

    expect(surface.renders).toHaveLength(2);
  });

  it('projects the four tray states the machine drives', () => {
    const surface = recordingSurface();
    const tray = createTrayController(surface);

    tray.set('active');
    expect(surface.last.glyph).toBe('active');
    tray.set('attention');
    expect(surface.last.glyph).toBe('attention');
  });

  /**
   * The regression behind ADR-0028, and the only test here that can still catch it.
   *
   * Mute used to have two producers: the menu row, and `surface.onClick`. On macOS opening the menu
   * *is* a left-click, so reading the status line silently muted Riki. The channel is gone from
   * `TraySurface` now, which means no test can call it — so what is asserted instead is the thing
   * that went wrong one level up: how many channels the controller subscribes to at all.
   *
   * Re-add a click subscription in `createTrayController` and this fails, whatever it is wired to.
   */
  it('subscribes to one channel, so mute cannot acquire a second producer', () => {
    const reads: string[] = [];
    const surface = new Proxy(recordingSurface(), {
      get(target, prop, receiver): unknown {
        if (typeof prop === 'string') reads.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });

    createTrayController(surface);

    expect(reads.filter((prop) => prop.startsWith('on'))).toEqual(['onAction']);
  });

  it('toggles mute from the menu row and from nothing else', () => {
    const surface = recordingSurface();
    const tray = createTrayController(surface);

    let toggles = 0;
    tray.onToggleMute(() => (toggles += 1));

    tray.set('active');
    tray.setStatus('Watching the game.');
    surface.choose('quit');
    expect(toggles).toBe(0);

    surface.choose('toggle-mute');
    expect(toggles).toBe(1);
  });

  it('keeps the mute row off the generic action channel, so Quit stays out of reach', () => {
    const surface = recordingSurface();
    const tray = createTrayController(surface);

    const seen: TrayAction[] = [];
    tray.onAction((action) => seen.push(action));

    surface.choose('toggle-mute');
    expect(seen).toEqual([]);

    surface.choose('quit');
    expect(seen).toEqual(['quit']);
  });

  it('destroys the surface on dispose — a stale Tray keeps an icon on the bar', () => {
    const surface = recordingSurface();
    const tray = createTrayController(surface);
    tray.dispose();
    expect(surface.destroyed).toBe(true);
  });
});
