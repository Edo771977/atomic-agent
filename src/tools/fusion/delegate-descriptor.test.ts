import { describe, expect, it } from "vitest";

import { getDefaultArgsJsonSchema } from "../../prompt/default-tool-args-schemas.js";
import { getToolDescriptorByName } from "../../prompt/tool-descriptors.js";
import { MAX_DELEGATE_TASKS, parseDelegateArgs } from "./delegate-args.js";

/**
 * The `fusion.delegate` descriptor teaches the orchestrator the call; the
 * JSON schema is what the wire and the grammar accept. They drifted once
 * (the text said 1..8 tasks while the schema took 16, and named neither
 * `maxSteps`, `timeoutMs`, `role`, `model` nor `shape`), so they are
 * checked against each other here.
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: readonly unknown[];
  minItems?: number;
  maxItems?: number;
};

/** The subset of JSON Schema the default schemas use, enough to reject drift. */
function violations(value: unknown, schema: Schema, at = "$"): string[] {
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return [`${at}: not one of ${schema.enum.join("|")}`];
  }
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? [] : [`${at}: not a string`];
    case "number":
      return typeof value === "number" ? [] : [`${at}: not a number`];
    case "integer":
      return Number.isInteger(value) ? [] : [`${at}: not an integer`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at}: not a boolean`];
    case "array": {
      if (!Array.isArray(value)) return [`${at}: not an array`];
      const out: string[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: too few`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: too many`);
      value.forEach((item, i) => {
        if (schema.items) out.push(...violations(item, schema.items, `${at}[${i}]`));
      });
      return out;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [`${at}: not an object`];
      }
      const record = value as Record<string, unknown>;
      const out: string[] = [];
      for (const key of schema.required ?? []) {
        if (!(key in record)) out.push(`${at}.${key}: missing`);
      }
      for (const [key, child] of Object.entries(record)) {
        const prop = schema.properties?.[key];
        if (prop !== undefined) out.push(...violations(child, prop, `${at}.${key}`));
        else if (schema.additionalProperties === false) out.push(`${at}.${key}: not allowed`);
        else if (typeof schema.additionalProperties === "object") {
          out.push(...violations(child, schema.additionalProperties, `${at}.${key}`));
        }
      }
      return out;
    }
    default:
      return [];
  }
}

const descriptor = getToolDescriptorByName("fusion.delegate")!;
const schema = getDefaultArgsJsonSchema("fusion.delegate") as Schema;
const taskSchema = schema.properties!.tasks!;
const taskProps = taskSchema.items!.properties!;
const provideProps =
  schema.properties!.contract!.properties!.provides!.items!.properties!;

describe("fusion.delegate descriptor and schema agree", () => {
  it("states the task count the schema and the parser accept", () => {
    expect(taskSchema.minItems).toBe(1);
    expect(taskSchema.maxItems).toBe(MAX_DELEGATE_TASKS);
    expect(descriptor.argsSchema).toContain(`/* 1..${MAX_DELEGATE_TASKS} */`);
  });

  it("names every task field, top-level field and provide field the schema has", () => {
    const named = (key: string): boolean =>
      new RegExp(`\\b${key}\\??(:|,| })`).test(descriptor.argsSchema);
    for (const key of [
      ...Object.keys(taskProps),
      ...Object.keys(schema.properties!),
      ...Object.keys(provideProps),
    ]) {
      expect(named(key), key).toBe(true);
    }
    // The roles the text lists are the schema's.
    for (const role of taskProps.role!.enum!) {
      expect(descriptor.argsSchema).toContain(`"${role as string}"`);
    }
  });

  it("gives an example the schema and the parser both accept", () => {
    expect(descriptor.examples?.length).toBeGreaterThan(0);
    for (const example of descriptor.examples ?? []) {
      const args = JSON.parse(example) as Record<string, unknown>;
      expect(violations(args, schema)).toEqual([]);
      const parsed = parseDelegateArgs(args);
      expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    }
  });

  it("shows an edit task with files, a deliverable and a check", () => {
    // The shape a weak worker does best with: one function edited in
    // place, its files declared, what to hand back, and how it is checked.
    const examples = (descriptor.examples ?? []).map(
      (e) => JSON.parse(e) as {
        tasks: { id: string; files?: string[]; deliverable?: string; instructions: string }[];
        contract?: { checks?: { task?: string }[]; provides?: { shape?: string }[] };
      },
    );
    const edit = examples.find((e) =>
      e.tasks.some(
        (t) =>
          (t.files?.length ?? 0) > 0 &&
          t.deliverable !== undefined &&
          /in place|edit/i.test(t.instructions) &&
          e.contract?.checks?.some((c) => c.task === t.id) === true,
      ),
    );
    expect(edit).toBeDefined();
    expect(edit?.contract?.provides?.some((p) => p.shape !== undefined)).toBe(true);
  });

  it("does not tie the workers to a local leg in its summary", () => {
    // Workers run on a cloud leg too; sizing is the ### fusion block's job.
    expect(descriptor.summary).not.toContain("local worker agents");
    expect(descriptor.summary).toContain("### fusion");
  });

  it("says a local worker sees only the first ~6,000 chars of the request", () => {
    expect(descriptor.summary).toContain(
      "A local worker's brief quotes only the first ~6,000 chars of the request, so there `instructions` must also carry whatever beyond those the task needs.",
    );
  });
});
