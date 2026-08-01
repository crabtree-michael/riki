/**
 * Argument declarations, from which both the validator and the schema are generated.
 *
 * > **The schema and the validator must have one source.**
 *
 * A hand-written JSON Schema that has drifted from its validator is the exact failure `pnpm
 * codegen` exists to prevent for the sidecar, and it presents identically: the model is told a
 * shape, sends it, and is told it is invalid. So a command declares its arguments once, as the
 * record below, and `schema` and `decode` are both derived from that record.
 *
 * **Why not zod, which §4.2 of the architecture names.** zod is the repo's schema tool because
 * `packages/protocol` will generate JSON Schema *and Rust* from it (REPO_SKELETON.md §4) — and
 * that package is step 2 and still empty, so adopting zod here would mean choosing the version and
 * the JSON-Schema emitter that protocol has yet to choose, in a package that does not cross a
 * language boundary. These declarations are eight commands' worth of flat string and enum
 * arguments; the derivation below is small enough to read in one sitting and holds the single-source
 * property that actually matters. ADR-0018 records the decision and the migration.
 *
 * See docs/design/agent-command-execution-architecture.md §4.2.
 */

import type { ArgumentCodec, JsonSchemaObject } from './contracts.js';
import type { ToolOutcome } from './types.js';
import { failure, ok } from './failures.js';

// -----------------------------------------------------------------------------------------------
// Declaration
// -----------------------------------------------------------------------------------------------

interface FieldBase {
  /** Shown to the model in the manifest. Prompt, not code (§15.1). */
  readonly description: string;
  readonly optional?: true;
}

/**
 * `hero`, `item` and `region` decode as strings and are resolved in the next stage.
 *
 * Keeping them a distinct *kind* rather than a plain string is what lets the pipeline resolve
 * subjects generically (`resolve.ts`) instead of each handler doing its own alias lookup — eight
 * handlers, eight alias tables, eight chances to disagree about whether `nevermore` is Shadow Fiend.
 */
export type SubjectKind = 'hero' | 'item' | 'region';

export type FieldSpec =
  | (FieldBase & { readonly kind: 'string'; readonly maxLength?: number })
  | (FieldBase & { readonly kind: 'integer'; readonly min?: number; readonly max?: number })
  | (FieldBase & { readonly kind: 'boolean' })
  | (FieldBase & { readonly kind: 'enum'; readonly values: readonly string[] })
  | (FieldBase & { readonly kind: SubjectKind });

export type FieldSpecs = Readonly<Record<string, FieldSpec>>;

type FieldValue<F> = F extends { readonly kind: 'integer' }
  ? number
  : F extends { readonly kind: 'boolean' }
    ? boolean
    : F extends { readonly kind: 'enum'; readonly values: readonly (infer V)[] }
      ? V
      : string;

type OptionalKeys<S> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never;
}[keyof S];

type RequiredKeys<S> = Exclude<keyof S, OptionalKeys<S>>;

/** The argument object a handler receives, inferred from the declaration and nothing else. */
export type ArgsOf<S extends FieldSpecs> = {
  readonly [K in RequiredKeys<S>]: FieldValue<S[K]>;
} & {
  readonly [K in OptionalKeys<S>]?: FieldValue<S[K]>;
};

// -----------------------------------------------------------------------------------------------
// Derivation
// -----------------------------------------------------------------------------------------------

function schemaForField(spec: FieldSpec): JsonSchemaObject {
  switch (spec.kind) {
    case 'string':
      return spec.maxLength === undefined
        ? { type: 'string', description: spec.description }
        : { type: 'string', description: spec.description, maxLength: spec.maxLength };
    case 'integer':
      return {
        type: 'integer',
        description: spec.description,
        ...(spec.min === undefined ? {} : { minimum: spec.min }),
        ...(spec.max === undefined ? {} : { maximum: spec.max }),
      };
    case 'boolean':
      return { type: 'boolean', description: spec.description };
    case 'enum':
      return { type: 'string', description: spec.description, enum: [...spec.values] };
    case 'hero':
    case 'item':
    case 'region':
      // Deliberately *not* an enum of the current draft: the manifest is frozen for the session
      // (ADR-0011) and the draft is not known when it is built. Membership is checked at
      // resolution instead, which is also where a good `unknown_subject` answer can be written.
      return { type: 'string', description: spec.description };
  }
}

/** A spoken phrase for the failure sentence. The model hears this, so it is words, not a schema. */
function spokenName(name: string, spec: FieldSpec): string {
  switch (spec.kind) {
    case 'hero':
      return 'a hero';
    case 'item':
      return 'an item';
    case 'region':
      return 'a part of the screen';
    default:
      return `a ${name.replace(/[_-]/g, ' ')}`;
  }
}

function decodeField(name: string, spec: FieldSpec, raw: unknown): ToolOutcome<unknown> {
  switch (spec.kind) {
    case 'string':
    case 'hero':
    case 'item':
    case 'region': {
      if (typeof raw !== 'string' || raw.trim() === '') {
        return failure('invalid_arguments', {
          speak: `I need ${spokenName(name, spec)} for that — which one?`,
          detail: `${name}: expected a non-empty string, got ${typeName(raw)}`,
        });
      }
      const max = spec.kind === 'string' ? spec.maxLength : undefined;
      if (max !== undefined && raw.length > max) {
        return failure('invalid_arguments', {
          speak: `That's more than I can look up at once.`,
          detail: `${name}: length ${String(raw.length)} exceeds ${String(max)}`,
        });
      }
      return ok(raw.trim());
    }
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
        return failure('invalid_arguments', {
          speak: `I need ${spokenName(name, spec)} as a number.`,
          detail: `${name}: expected an integer, got ${typeName(raw)}`,
        });
      }
      if (
        (spec.min !== undefined && raw < spec.min) ||
        (spec.max !== undefined && raw > spec.max)
      ) {
        return failure('invalid_arguments', {
          speak: `That's outside what I can look back over.`,
          detail: `${name}: ${String(raw)} outside [${String(spec.min)}, ${String(spec.max)}]`,
        });
      }
      return ok(raw);
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        return failure('invalid_arguments', {
          speak: `I didn't catch that — say it again?`,
          detail: `${name}: expected a boolean, got ${typeName(raw)}`,
        });
      }
      return ok(raw);
    }
    case 'enum': {
      if (typeof raw !== 'string' || !spec.values.includes(raw)) {
        return failure('invalid_arguments', {
          speak: `I can do ${spec.values.join(' or ')} for that.`,
          detail: `${name}: expected one of ${spec.values.join('|')}, got ${typeName(raw)}`,
        });
      }
      return ok(raw);
    }
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * The codec for a declaration, plus the subject fields the resolver has to walk.
 *
 * Extra properties are **rejected**, matching the `additionalProperties: false` the model is shown.
 * Silently ignoring them would mean the schema and the validator disagree in the one direction the
 * property test does not cover, and §2.2's warning applies: the way this goes wrong is eight
 * handlers each being lenient in a slightly different way.
 */
export interface DeclaredCodec<S extends FieldSpecs> extends ArgumentCodec<ArgsOf<S>> {
  readonly fields: S;
  /** `[name, kind]` for every `hero` / `item` / `region` field, in declaration order. */
  readonly subjects: readonly (readonly [string, SubjectKind])[];
}

export function defineArgs<const S extends FieldSpecs>(fields: S): DeclaredCodec<S> {
  const names = Object.keys(fields);
  const required = names.filter((name) => fields[name]?.optional !== true);

  const properties: Record<string, JsonSchemaObject> = {};
  for (const name of names) {
    const spec = fields[name];
    if (spec !== undefined) properties[name] = schemaForField(spec);
  }

  const schema: JsonSchemaObject = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };

  const subjects = names.flatMap((name): (readonly [string, SubjectKind])[] => {
    const kind = fields[name]?.kind;
    return kind === 'hero' || kind === 'item' || kind === 'region' ? [[name, kind] as const] : [];
  });

  return {
    schema,
    fields,
    subjects,

    decode(raw: unknown): ToolOutcome<ArgsOf<S>> {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return failure('invalid_arguments', {
          detail: `expected an object, got ${typeName(raw)}`,
        });
      }
      const source = raw as Record<string, unknown>;

      for (const key of Object.keys(source)) {
        if (!(key in fields)) {
          return failure('invalid_arguments', {
            speak:
              names.length === 0
                ? "That one doesn't take any details."
                : `I only need ${names.join(' and ')} for that.`,
            detail: `unexpected property ${JSON.stringify(key)}`,
          });
        }
      }

      const out: Record<string, unknown> = {};
      for (const name of names) {
        const spec = fields[name];
        if (spec === undefined) continue;
        const value = source[name];
        if (value === undefined) {
          if (spec.optional === true) continue;
          return failure('invalid_arguments', {
            speak: `I need ${spokenName(name, spec)} for that — which one?`,
            detail: `${name}: missing`,
          });
        }
        const decoded = decodeField(name, spec, value);
        if (!decoded.ok) return decoded;
        out[name] = decoded.value;
      }

      return ok(out as ArgsOf<S>);
    },
  };
}

/** The zero-argument declaration, spelled once so the six commands that take none agree. */
export const NO_ARGS = defineArgs({});
