/**
 * The library of mock game states a rehearsal can be run against (ADR-0038).
 *
 * ## Why `fixtures/gsi/` and not a new set
 *
 * The alternative was a handful of named states declared in TypeScript, hand-shaped for the
 * inspector. It would have been less code and it would have been a second corpus: `shell.test.ts`
 * replays `fixtures/gsi/laning-phase.jsonl` through the whole composition root, `FakeGsiSource` is
 * how `pnpm dev:replay` is meant to drive the app, and the fixture headers already carry the one
 * fact about a state that matters — whether somebody captured it or made it up. A scenario a
 * developer adds to make the dropdown useful is then a scenario the suite can assert against, and
 * one added for a test appears in the dropdown the same day.
 *
 * The cost is stated rather than hidden: **a `.jsonl` is a timeline, not a moment.** The state a
 * rehearsal sees is what the whole file fuses to, so `draft.jsonl` is the draft as it stood at the
 * last recorded POST. Picking a point part-way through would need a second control and is
 * `debug-inspector.md` §9's open question.
 *
 * ## Read every time, not cached
 *
 * `list()` re-reads the directory on each call, and the frame pump calls it four times a second
 * while the window is open. That is a directory listing and a few kilobytes of `JSON.parse` — the
 * same order as the frame it is going into — and it buys the thing a cache would take away: a
 * developer who drops a new fixture in while the window is open sees it in the dropdown without
 * restarting the app, which is exactly the iteration loop this feature exists to shorten.
 *
 * A parse failure is a **skipped file with a reason**, never a throw. This is read on the frame
 * path, and one malformed line in one fixture must not be able to empty the dropdown or take the
 * window down with it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import type { GsiFixtureLine } from '@riki/gsi/testing';
import { parseGsiFixture } from '@riki/gsi/testing';

import type { DebugMockState } from '../../shared/debug.js';
import { DEBUG_LIMITS } from '../../shared/debug.js';

/** A mock state with the recording behind it. `DebugMockState` is this minus the payloads. */
export interface MockState {
  readonly id: string;
  readonly label: string;
  readonly note: string | null;
  readonly lines: readonly GsiFixtureLine[];
}

export interface MockStateLibrary {
  /** Newest problems first is not a thing here: sorted by id, so the dropdown does not reorder. */
  list(): readonly MockState[];
  get(id: string): MockState | null;
}

/**
 * The filesystem, as two calls, so the library is a Tier 1 test with no disk.
 *
 * Narrower than `node:fs` on purpose: a port that could open a path the caller named would put the
 * decision about *which* files are readable back into a component reached from a renderer intent.
 * What crosses the bridge is an id; what this resolves it against is a listing of one directory.
 */
export interface MockStateFiles {
  /** Base names, including the extension. Empty when the directory does not exist. */
  list(): readonly string[];
  /** The file's contents, or null when it could not be read. */
  read(name: string): string | null;
}

/** The empty library — no directory was configured, so the dropdown says so rather than guessing. */
export function emptyMockStateLibrary(): MockStateLibrary {
  return { list: () => [], get: () => null };
}

export function nodeMockStateFiles(dir: string): MockStateFiles {
  return {
    list(): readonly string[] {
      try {
        return readdirSync(dir);
      } catch {
        // A packaged build has no `fixtures/` beside it, and a dev clone without one is a clone
        // somebody is about to `git pull`. Neither is a fault worth reporting on every frame.
        return [];
      }
    },

    read(name: string): string | null {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

export interface MockStateLibraryDeps {
  readonly files: MockStateFiles;
  /**
   * A parse that failed, so the reason reaches the Problems panel rather than a dropped row.
   *
   * Optional because the library is useful without one, and because the hub is not the only
   * plausible sink for it.
   */
  readonly onProblem?: (message: string) => void;
}

export function createMockStateLibrary(deps: MockStateLibraryDeps): MockStateLibrary {
  function load(name: string): MockState | null {
    const contents = deps.files.read(name);
    if (contents === null) {
      deps.onProblem?.(`mock state ${name} could not be read`);
      return null;
    }

    let lines: readonly GsiFixtureLine[];
    try {
      lines = parseGsiFixture(contents);
    } catch (error: unknown) {
      deps.onProblem?.(
        `mock state ${name} did not parse: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const id = basename(name, extname(name));
    return { id, label: id.replace(/-/g, ' '), note: headerOf(contents), lines };
  }

  function list(): readonly MockState[] {
    return deps.files
      .list()
      .filter((name) => extname(name) === '.jsonl')
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, DEBUG_LIMITS.mockStates)
      .map(load)
      .filter((state): state is MockState => state !== null);
  }

  return {
    list,
    // Through `list` rather than by joining the id onto the directory, which is the whole of what
    // stops `../../etc/passwd` from being a mock state: the id is matched against a listing this
    // component produced, and a name that is not in it does not resolve to a read at all.
    get: (id: string) => list().find((state) => state.id === id) ?? null,
  };
}

/**
 * The recording's own first comment line, which is where `fixtures/gsi/`'s headers say whether the
 * file was captured from a game or synthesised. That distinction is the single most useful thing to
 * put beside a scenario name, and it is the one thing the parsed lines throw away.
 */
function headerOf(contents: string): string | null {
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('//')) return null;
    const text = trimmed.slice(2).trim();
    if (text !== '') return text;
  }
  return null;
}

/** The frame's shape: the description, without the payloads it describes. */
export function projectMockStates(states: readonly MockState[]): readonly DebugMockState[] {
  return states.map((state) => ({
    id: state.id,
    label: state.label,
    note: state.note,
    observations: state.lines.length,
  }));
}
