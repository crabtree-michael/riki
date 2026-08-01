/**
 * The only file in the tray component that imports Electron.
 *
 * Two platform facts are encoded here rather than discovered later:
 *
 * - **Template images.** macOS is the primary target, and a menu-bar icon that follows light/dark
 *   (ui-design.md §2.3) is not a pair of assets — it is one all-black image with an alpha channel
 *   whose filename ends in `Template`, plus `setTemplateImage(true)`. Without the flag AppKit
 *   renders the black pixels literally, which is invisible in dark mode. `scripts/
 *   generate-tray-glyphs.mjs` produces them.
 * - **`Tray` must be constructed after `app.whenReady()`**, and it must be held in a variable that
 *   outlives the function that made it. A `Tray` that is only referenced by a local is garbage
 *   collected and the icon silently disappears, usually minutes later — which is why the shell
 *   holds the controller for the life of the app rather than re-creating it.
 *
 * The right-click menu is rebuilt on every render rather than mutated. Electron's `Menu` is
 * immutable once built, and the alternative — tracking which item changed — is bookkeeping in
 * exchange for nothing: the menu is five rows and is rebuilt at most a few times a match.
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';

import type { TrayGlyph, Unsubscribe } from '../../shared/overlay.js';
import type { TrayAction, TrayMenuItem } from './menu.js';
import type { TraySurface } from './index.js';

export interface ElectronTrayOptions {
  /** Absolute path to `apps/desktop/resources/tray`. */
  readonly iconDir: string;
}

function iconFor(dir: string, glyph: TrayGlyph): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(dir, `${glyph}Template.png`));
  // Without this the glyph is drawn in literal black and vanishes in dark mode. It is a no-op on
  // Windows and Linux, where the image is used as given.
  image.setTemplateImage(true);
  return image;
}

export function createElectronTray(options: ElectronTrayOptions): TraySurface {
  const tray = new Tray(iconFor(options.iconDir, 'idle'));
  const actionListeners = new Set<(action: TrayAction) => void>();
  const clickListeners = new Set<() => void>();

  const onClick = (): void => {
    for (const listener of [...clickListeners]) listener();
  };
  tray.on('click', onClick);

  function toTemplate(items: readonly TrayMenuItem[]): MenuItemConstructorOptions[] {
    return items.map((item): MenuItemConstructorOptions => {
      if (item.kind === 'separator') return { type: 'separator' };
      if (item.kind === 'label') {
        return { label: item.label ?? '', enabled: false };
      }
      const id = item.id;
      return {
        label: item.label ?? '',
        enabled: item.enabled ?? true,
        ...(item.checked === undefined ? {} : { type: 'checkbox', checked: item.checked }),
        ...(item.accelerator === undefined ? {} : { accelerator: item.accelerator }),
        click: (): void => {
          if (id === undefined) return;
          for (const listener of [...actionListeners]) listener(id);
        },
      };
    });
  }

  return {
    render(glyph, tooltip, menu): void {
      if (tray.isDestroyed()) return;
      tray.setImage(iconFor(options.iconDir, glyph));
      tray.setToolTip(tooltip);
      tray.setContextMenu(Menu.buildFromTemplate(toTemplate(menu)));
    },

    onAction(listener): Unsubscribe {
      actionListeners.add(listener);
      return () => actionListeners.delete(listener);
    },

    onClick(listener): Unsubscribe {
      clickListeners.add(listener);
      return () => clickListeners.delete(listener);
    },

    destroy(): void {
      actionListeners.clear();
      clickListeners.clear();
      if (!tray.isDestroyed()) {
        tray.off('click', onClick);
        tray.destroy();
      }
    },
  };
}
