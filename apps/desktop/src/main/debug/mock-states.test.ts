/**
 * The library behind the inspector's mock-state dropdown (ADR-0038).
 *
 * Tier 1, and the reason it can be is `MockStateFiles`: the component takes a two-method view of a
 * directory rather than `node:fs`, so every case below — including the ones a real disk makes
 * awkward, like a file that vanishes between the listing and the read — is a fake returning a
 * string.
 *
 * What is asserted is the behaviour a developer would be misled by. A malformed fixture must cost
 * its own row and nothing else, because this is read on the frame path four times a second and one
 * bad file emptying the dropdown would look like the feature being broken. And an id must not be
 * able to reach a file the listing did not offer, because the id is the only thing that crosses the
 * bridge from a renderer.
 */

import { describe, expect, it } from 'vitest';

import { createMockStateLibrary, emptyMockStateLibrary, projectMockStates } from './mock-states.js';
import type { MockStateFiles } from './mock-states.js';

/** One GSI payload per line, which is what `parseGsiFixture` reads. */
function recording(lines: number, header: string | null = null): string {
  const body = Array.from({ length: lines }, (_, index) =>
    JSON.stringify({ atMs: index * 250, body: { map: { clock_time: 60 + index } } }),
  );
  return [...(header === null ? [] : [`// ${header}`]), ...body].join('\n');
}

function files(entries: Record<string, string | null>): MockStateFiles {
  return {
    list: () => Object.keys(entries),
    read: (name) => entries[name] ?? null,
  };
}

describe('listing', () => {
  it('offers one row per .jsonl, sorted so the dropdown does not reorder under the reader', () => {
    const library = createMockStateLibrary({
      files: files({
        'laning-phase.jsonl': recording(3),
        'draft.jsonl': recording(2),
        'README.md': 'not a recording',
        'notes.txt': 'nor this',
      }),
    });

    // Sorted by name rather than by directory order, which is the filesystem's business and is not
    // stable across machines. A dropdown whose rows moved between frames would be unusable at 4 Hz.
    expect(library.list().map((state) => state.id)).toEqual(['draft', 'laning-phase']);
  });

  it('reads the id and label off the file name, and the note off the recording', () => {
    const library = createMockStateLibrary({
      files: files({ 'laning-phase.jsonl': recording(3, 'SYNTHETIC — assembled by hand') }),
    });

    const state = library.list()[0];
    expect(state?.id).toBe('laning-phase');
    // Hyphens out of the label: the id is a file name and the label is read by a person.
    expect(state?.label).toBe('laning phase');
    // The header is where `fixtures/gsi/` records whether somebody captured the state or made it
    // up, which is the one fact worth having beside a scenario name.
    expect(state?.note).toBe('SYNTHETIC — assembled by hand');
    expect(state?.lines).toHaveLength(3);
  });

  it('has no note when the recording opens with a payload rather than a comment', () => {
    const library = createMockStateLibrary({ files: files({ 'bare.jsonl': recording(1) }) });
    // Null rather than a plausible empty string: "no header" and "an empty header" are different
    // claims, and this window exists to keep those apart.
    expect(library.list()[0]?.note).toBeNull();
  });

  it('re-reads on every call, so a fixture dropped in mid-session appears without a restart', () => {
    const entries: Record<string, string> = { 'draft.jsonl': recording(2) };
    const library = createMockStateLibrary({
      files: { list: () => Object.keys(entries), read: (name) => entries[name] ?? null },
    });

    expect(library.list()).toHaveLength(1);
    entries['laning-phase.jsonl'] = recording(3);
    // The whole reason this is uncached: shortening the iteration loop is what the feature is for,
    // and restarting the app to see a new scenario would put a chunk of it back.
    expect(library.list()).toHaveLength(2);
  });

  it('is empty, not broken, when the directory does not exist', () => {
    const library = createMockStateLibrary({ files: { list: () => [], read: () => null } });
    expect(library.list()).toEqual([]);
    expect(emptyMockStateLibrary().list()).toEqual([]);
  });
});

describe('a file that will not parse', () => {
  it('costs its own row and reports why, rather than emptying the dropdown', () => {
    const problems: string[] = [];
    const library = createMockStateLibrary({
      files: files({
        'broken.jsonl': '{ this is not json',
        'laning-phase.jsonl': recording(3),
      }),
      onProblem: (message) => problems.push(message),
    });

    // The load-bearing assertion: this runs on the frame path, so one malformed fixture must not be
    // able to take the panel — or the window — down with it.
    expect(library.list().map((state) => state.id)).toEqual(['laning-phase']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('broken.jsonl');
    expect(problems[0]).toContain('did not parse');
  });

  it('reports a file that vanished between the listing and the read', () => {
    const problems: string[] = [];
    const library = createMockStateLibrary({
      files: { list: () => ['gone.jsonl'], read: () => null },
      onProblem: (message) => problems.push(message),
    });

    expect(library.list()).toEqual([]);
    expect(problems[0]).toContain('could not be read');
  });

  it('is useful with no problem sink at all', () => {
    const library = createMockStateLibrary({ files: files({ 'broken.jsonl': '{{{' }) });
    expect(() => library.list()).not.toThrow();
    expect(library.list()).toEqual([]);
  });
});

describe('resolving an id', () => {
  it('finds a state that is on offer', () => {
    const library = createMockStateLibrary({
      files: files({ 'draft.jsonl': recording(2), 'laning-phase.jsonl': recording(3) }),
    });
    expect(library.get('draft')?.lines).toHaveLength(2);
  });

  it('refuses a name the listing never offered', () => {
    const library = createMockStateLibrary({
      files: files({ 'draft.jsonl': recording(2) }),
    });

    // The whole of what keeps a renderer intent from naming an arbitrary file: `get` matches
    // against a listing this component produced, so a traversal is not a read that fails — it is a
    // name that resolves to nothing at all.
    expect(library.get('../../etc/passwd')).toBeNull();
    expect(library.get('/etc/passwd')).toBeNull();
    expect(library.get('draft.jsonl')).toBeNull();
    expect(library.get('')).toBeNull();
  });
});

describe('the frame projection', () => {
  it('carries the description and drops the payloads', () => {
    const library = createMockStateLibrary({
      files: files({ 'draft.jsonl': recording(4, 'CAPTURED from a real game') }),
    });

    const projected = projectMockStates(library.list());
    expect(projected).toEqual([
      { id: 'draft', label: 'draft', note: 'CAPTURED from a real game', observations: 4 },
    ]);
    // A frame crosses IPC four times a second. The recordings behind these rows are kilobytes each
    // and the renderer has no use for them: it sends back an id.
    expect(JSON.stringify(projected)).not.toContain('clock_time');
  });
});
