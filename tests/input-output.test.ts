import * as v from "valibot";
import { beforeAll, describe, expect, it } from "vitest";
import z3 from "zod/v3";
import z from "zod/v4";
import { loadVendor, toOpenAPISchema } from "~/index.js";
import { convertToOpenAPISchema } from "~/vendors/convert.js";
import type { ToOpenAPISchemaContext } from "~/vendors/utils.js";

it("describes defaults and unknown properties on each side (Zod 4)", async () => {
  const schema = z.object({ name: z.string().default("Ada") });
  const request = { extra: true };
  const response = JSON.parse(JSON.stringify(schema.parse(request)));
  expect(response).toEqual({ name: "Ada" });
  const input = await toOpenAPISchema(schema, { io: "input" });
  const output = await toOpenAPISchema(schema, { io: "output" });
  expect(input.schema.required ?? []).not.toContain("name");
  expect(input.schema.additionalProperties).not.toBe(false);
  expect(output.schema).toMatchObject({
    required: ["name"],
    additionalProperties: false,
  });
  expect(input.schema.properties?.name).toMatchObject({
    type: "string",
    default: "Ada",
  });
});

describe("Zod 3 output compatibility (ENG-2960)", () => {
  const schema = z3.object({ name: z3.string().default("Ada") });
  let input: Awaited<ReturnType<typeof toOpenAPISchema>>;
  let output: Awaited<ReturnType<typeof toOpenAPISchema>>;

  // Conversion failures must fail the suite, not satisfy the expected failure.
  beforeAll(async () => {
    input = await toOpenAPISchema(schema, { io: "input" });
    output = await toOpenAPISchema(schema, { io: "output" });
  });

  it("preserves parsing, defaults and directional requiredness", () => {
    expect(JSON.parse(JSON.stringify(schema.parse({ extra: true })))).toEqual({
      name: "Ada",
    });
    expect(input.schema.required ?? []).not.toContain("name");
    expect(input.schema.additionalProperties).not.toBe(false);
    expect(input.schema.properties?.name).toMatchObject({
      type: "string",
      default: "Ada",
    });
    expect(output.schema).toMatchObject({ required: ["name"] });
  });

  // Existing zod-openapi@4 defect; exception and removal condition: PHOTON.md.
  // An unexpected pass fails CI so a compatible upstream fix removes this marker.
  it.fails("KNOWN LIMITATION: closes stripping Zod 3 output objects", () => {
    expect(output.schema.additionalProperties).toBe(false);
  });
});

it("preserves strict, open and typed objects in nested unions", async () => {
  const strict = z.strictObject({
    kind: z.literal("strict"),
    name: z.string(),
  });
  const open = z.looseObject({ kind: z.literal("open"), name: z.string() });
  const typed = z
    .object({ kind: z.literal("typed"), name: z.string() })
    .catchall(z.string());
  const schema = z.object({ value: z.union([strict, open, typed]) });
  expect(
    strict.safeParse({ kind: "strict", name: "Ada", extra: true }).success,
  ).toBe(false);
  expect(open.parse({ kind: "open", name: "Ada", extra: true })).toHaveProperty(
    "extra",
    true,
  );
  expect(
    typed.safeParse({ kind: "typed", name: "Ada", extra: true }).success,
  ).toBe(false);
  expect(
    typed.parse({ kind: "typed", name: "Ada", extra: "ok" }),
  ).toHaveProperty("extra", "ok");
  for (const io of ["input", "output"] as const) {
    const result = await toOpenAPISchema(schema, { io });
    expect(result.schema.properties?.value).toMatchObject({
      anyOf: [
        { additionalProperties: false },
        {},
        { additionalProperties: { type: "string" } },
      ],
    });
    const variants = (
      result.schema.properties?.value as {
        anyOf: { additionalProperties?: unknown }[];
      }
    ).anyOf;
    expect(variants[1].additionalProperties).not.toBe(false);
  }
});

it("keeps named input and output components independent across repeated conversions", async () => {
  const shared = z
    .object({ count: z.number().default(1) })
    .meta({ ref: "Shared" });
  const components: ToOpenAPISchemaContext["components"] = {};
  const input = await toOpenAPISchema(shared, { io: "input", components });
  const before = structuredClone(components);
  const output = await toOpenAPISchema(shared, { io: "output", components });
  expect(input.schema).toEqual({ $ref: "#/components/schemas/input__Shared" });
  expect(output.schema).toEqual({
    $ref: "#/components/schemas/output__Shared",
  });
  expect(components.schemas?.input__Shared).toEqual(
    before.schemas?.input__Shared,
  );
  expect(components.schemas?.output__Shared).toMatchObject({
    required: ["count"],
    additionalProperties: false,
  });
  await toOpenAPISchema(shared, { io: "output", components });
  expect(await toOpenAPISchema(shared, { io: "input", components })).toEqual(
    input,
  );
});

it("uses output types for pipes without changing runtime parsing", async () => {
  const schema = z
    .string()
    .transform((value) => value.length)
    .pipe(z.number());
  expect(schema.parse("hello")).toBe(5);
  expect((await toOpenAPISchema(schema, { io: "input" })).schema).toMatchObject(
    { type: "string" },
  );
  expect(
    (await toOpenAPISchema(schema, { io: "output" })).schema,
  ).toMatchObject({ type: "number" });
});

it("keeps recursive roots and definitions local to their direction", async () => {
  const node = z.object({
    name: z.string().default("root"),
    get children() {
      return z.array(node).optional();
    },
  });
  const schema = z.object({ first: node, second: node, json: z.json() });
  for (const io of ["input", "output"] as const) {
    const result = await toOpenAPISchema(schema, {
      io,
      options: { reused: "ref" },
    });
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string") {
          expect(child.startsWith(`#/components/schemas/${io}__`)).toBe(true);
          expect(result).toHaveProperty(
            child
              .slice(2)
              .split("/")
              .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")),
          );
        } else visit(child);
      }
    };
    visit(result);
    expect(
      schema.parse({ first: {}, second: {}, json: { nested: [null, true] } }),
    ).toMatchObject({ first: { name: "root" } });
  }
});

it("preserves local pointer suffixes, ref siblings, external refs and annotation data", () => {
  const context: ToOpenAPISchemaContext = { components: {} };
  const result = convertToOpenAPISchema(
    {
      type: "object",
      definitions: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            child: { $ref: "#/definitions/Node" },
          },
        },
      },
      properties: {
        name: {
          $ref: "#/definitions/Node/properties/name",
          description: "Name",
        },
        external: { $ref: "https://example.com/schema.json#/$defs/External" },
        self: { $ref: "#" },
        anything: true,
      },
      examples: [{ $ref: "#/definitions/Node", extra: 1 }],
    },
    context,
  );
  const root =
    context.components.schemas?.[
      (result as { $ref: string }).$ref.split("/").pop()!
    ];
  expect(root).toMatchObject({
    properties: {
      name: {
        $ref: "#/components/schemas/Node/properties/name",
        description: "Name",
      },
      external: { $ref: "https://example.com/schema.json#/$defs/External" },
      self: result,
      anything: true,
    },
    examples: [{ $ref: "#/definitions/Node", extra: 1 }],
  });
});

it("retains boolean definitions and scopes separate anonymous recursive schemas", async () => {
  const context: ToOpenAPISchemaContext = { components: {} };
  const result = convertToOpenAPISchema(
    {
      definitions: { Yes: true, No: false },
      anyOf: [{ $ref: "#/definitions/Yes" }, { $ref: "#/definitions/No" }],
    },
    context,
  );
  expect(context.components.schemas).toEqual({ Yes: true, No: false });
  expect(result).toEqual({
    anyOf: [
      { $ref: "#/components/schemas/Yes" },
      { $ref: "#/components/schemas/No" },
    ],
  });
  const first = z.object({
    value: z.string(),
    get next() {
      return first.optional();
    },
  });
  const second = z.object({
    value: z.number(),
    get next() {
      return second.optional();
    },
  });
  const components: ToOpenAPISchemaContext["components"] = {};
  const one = await toOpenAPISchema(first, { components, io: "output" });
  const two = await toOpenAPISchema(second, { components, io: "output" });
  expect(one.schema).not.toEqual(two.schema);
  expect(Object.keys(components.schemas ?? {})).toHaveLength(2);
});

it("forwards Valibot pipeline direction using its native typeMode", async () => {
  const schema = v.pipe(
    v.string(),
    v.transform((value) => value.length),
    v.number(),
  );
  expect(v.parse(schema, "Ada")).toBe(3);
  expect((await toOpenAPISchema(schema, { io: "input" })).schema).toMatchObject(
    { type: "string" },
  );
  expect(
    (await toOpenAPISchema(schema, { io: "output" })).schema,
  ).toMatchObject({ type: "number" });
});

it("relocates local discriminator mappings along with union references", () => {
  const context: ToOpenAPISchemaContext = { components: {} };
  const result = convertToOpenAPISchema(
    {
      definitions: {
        Dog: { type: "object", properties: { kind: { const: "dog" } } },
      },
      oneOf: [{ $ref: "#/definitions/Dog" }],
      discriminator: {
        propertyName: "kind",
        mapping: {
          dog: "#/definitions/Dog",
          remote: "https://example.com/cat.json",
        },
      },
    },
    context,
  );
  expect(result).toMatchObject({
    oneOf: [{ $ref: "#/components/schemas/Dog" }],
    discriminator: {
      mapping: {
        dog: "#/components/schemas/Dog",
        remote: "https://example.com/cat.json",
      },
    },
  });
});

it("retains custom vendor components and leaves example references as data", async () => {
  const schema = z.string();
  Object.assign(schema["~standard"], { vendor: "custom-component-test" });
  loadVendor("custom-component-test", (_schema, context) => {
    context.components.schemas = { Text: { type: "string" } };
    context.components.headers = {
      Name: { schema: { $ref: "#/components/schemas/Text" } },
    };
    context.components.examples = {
      Sample: { value: { $ref: "#/components/schemas/Text" } },
    };
    return { $ref: "#/components/schemas/Text" };
  });
  const result = await toOpenAPISchema(schema, { io: "output" });
  expect(result.components?.headers?.Name).toEqual({
    schema: { $ref: "#/components/schemas/output__Text" },
  });
  expect(result.components?.examples?.Sample).toEqual({
    value: { $ref: "#/components/schemas/Text" },
  });
});

it("scopes a discriminator's schema-name mapping in an output representation", async () => {
  const schema = z.object({ kind: z.literal("dog") });
  Object.assign(schema["~standard"], { vendor: "custom-union-test" });
  loadVendor("custom-union-test", (_schema, context) => {
    context.components.schemas = {
      Dog: {
        type: "object",
        properties: { kind: { type: "string", enum: ["dog"] } },
      },
    };
    return {
      oneOf: [{ $ref: "#/components/schemas/Dog" }],
      discriminator: { propertyName: "kind", mapping: { dog: "Dog" } },
    };
  });
  expect(
    (await toOpenAPISchema(schema, { io: "output" })).schema,
  ).toMatchObject({
    oneOf: [{ $ref: "#/components/schemas/output__Dog" }],
    discriminator: { mapping: { dog: "#/components/schemas/output__Dog" } },
  });
});

it("rejects conflicting non-schema components without replacing earlier definitions", async () => {
  const schema = z.string();
  Object.assign(schema["~standard"], { vendor: "shared-header-test" });
  loadVendor("shared-header-test", (_schema, context) => {
    context.components.schemas = { Text: { type: "string" } };
    context.components.headers = {
      Name: { schema: { $ref: "#/components/schemas/Text" } },
    };
    return { $ref: "#/components/schemas/Text" };
  });
  const components: ToOpenAPISchemaContext["components"] = {};
  await toOpenAPISchema(schema, { io: "input", components });
  const before = structuredClone(components);
  // An identical repeated definition is safe to share.
  await toOpenAPISchema(schema, { io: "input", components });
  expect(components).toEqual(before);
  await expect(
    toOpenAPISchema(schema, { io: "output", components }),
  ).rejects.toThrow('Conflicting headers component "Name"');
  expect(components).toEqual(before);
});
