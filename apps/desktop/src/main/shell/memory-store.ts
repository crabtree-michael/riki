/**
 * `MemoryStore` against a directory — the composition root's half of ADR-0013.
 *
 * `context-and-memory-architecture.md` §9.4 puts it here in as many words: *"Four methods, no
 * paths, no `fs`. The composition root implements it against a directory."* `packages/context` is
 * forbidden `node:fs` and `node:path` by lint precisely so this file is the only one that has to
 * be careful, and there are three things to be careful about:
 *
 * - **A key is not a path.** Keys come from `packages/context` (`PLAYER_MEMORY_KEY` today) and are
 *   plain identifiers, but the store must not become a way to write anywhere on disk if one ever
 *   contains a separator. Keys are validated, not sanitised: a rejected key is a bug to fix, and
 *   quietly rewriting it into something adjacent would hide it.
 * - **A write must not be able to leave a half-file.** Durable memory survives a crash by
 *   definition, and the crash it has to survive is the one during the write. Write to a temp file
 *   in the same directory, then rename — `rename` within a filesystem is atomic.
 * - **Reads are total.** `load()` promises that a missing, corrupt or version-mismatched file
 *   yields an empty memory rather than an error, and half of that promise is kept here: a read
 *   that fails for any reason answers `null`.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryStore } from '@riki/context';

/** Identifiers, not paths. No separator, no `..`, no leading dot. */
const VALID_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SUFFIX = '.json';

export interface FileMemoryStoreOptions {
  /** Absolute. Created on first write, not on construction — an unused Riki writes nothing. */
  readonly dir: string;
}

function assertKey(key: string): void {
  if (!VALID_KEY.test(key) || key.includes('..')) {
    throw new Error(`Invalid memory key: ${JSON.stringify(key)}`);
  }
}

export function createFileMemoryStore(options: FileMemoryStoreOptions): MemoryStore {
  const pathFor = (key: string): string => {
    assertKey(key);
    return join(options.dir, `${key}${SUFFIX}`);
  };

  return {
    async read(key: string): Promise<Uint8Array | null> {
      // Outside the `try`, deliberately. An invalid key is a bug in the caller and a missing file
      // is an ordinary condition; collapsing the two would turn "somebody passed a path" into
      // "there is no memory", which is silent and permanent.
      const path = pathFor(key);
      try {
        return await readFile(path);
      } catch {
        // Missing, unreadable, or a directory where a file should be. All of them mean the same
        // thing to the caller — there is no memory — and none of them is worth failing a match on.
        return null;
      }
    },

    async write(key: string, bytes: Uint8Array): Promise<void> {
      const target = pathFor(key);
      // Same directory as the target, so the rename stays within one filesystem. A temp file in
      // the OS temp dir can land on a different mount, where `rename` is a copy and is not atomic.
      const temporary = `${target}.tmp`;
      await mkdir(options.dir, { recursive: true });
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    },

    async delete(key: string): Promise<void> {
      await rm(pathFor(key), { force: true });
    },

    async list(prefix: string): Promise<readonly string[]> {
      let entries: readonly string[];
      try {
        entries = await readdir(options.dir);
      } catch {
        return [];
      }
      return entries
        .filter((name) => name.endsWith(SUFFIX))
        .map((name) => name.slice(0, -SUFFIX.length))
        .filter((key) => key.startsWith(prefix))
        .sort();
    },
  };
}
