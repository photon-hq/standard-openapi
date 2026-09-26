import { expect, it } from "vitest";
import z from "zod/v4";
import { toOpenAPISchema } from "~/index.js";
import { convertToOpenAPISchema } from "~/vendors/convert.js";
import type { ToOpenAPISchemaContext } from "~/vendors/utils.js";

const names = (components: ToOpenAPISchemaContext["components"]) =>
  Object.keys(components.schemas ?? {}).sort();

it("gives identical request and response representations one component", async () => {
  const status = z.enum(["active", "archived"]).meta({ ref: "WidgetStatus" });
  const point = z
    .strictObject({ x: z.number(), y: z.number(), status })
    .meta({ ref: "Point" });
  const components: ToOpenAPISchemaContext["components"] = {};
  const input = await toOpenAPISchema(point, { io: "input", components });
  const output = await toOpenAPISchema(point, { io: "output", components });
  expect(input.schema).toEqual({ $ref: "#/components/schemas/Point" });
  expect(output.schema).toEqual(input.schema);
  expect(names(components)).toEqual(["Point", "WidgetStatus"]);
  expect(components.schemas?.Point).toMatchObject({
    additionalProperties: false,
    properties: { status: { $ref: "#/components/schemas/WidgetStatus" } },
  });
});

it("keeps the response name and suffixes only request components that differ", async () => {
  const status = z.enum(["active", "archived"]).meta({ ref: "WidgetStatus" });
  const settings = z
    .strictObject({ retries: z.number().default(3) })
    .meta({ ref: "WidgetSettings" });
  const widget = z
    .strictObject({ name: z.string(), status, settings })
    .meta({ ref: "Widget" });
  const components: ToOpenAPISchemaContext["components"] = {};
  const input = await toOpenAPISchema(widget, { io: "input", components });
  await toOpenAPISchema(widget, { io: "output", components });
  expect(input.schema).toEqual({ $ref: "#/components/schemas/WidgetInput" });
  // Widget's own keywords match, but it refers to a request-specific
  // component, so its request representation differs as well.
  expect(names(components)).toEqual([
    "Widget",
    "WidgetInput",
    "WidgetSettings",
    "WidgetSettingsInput",
    "WidgetStatus",
  ]);
  expect(components.schemas?.WidgetInput).toMatchObject({
    properties: {
      status: { $ref: "#/components/schemas/WidgetStatus" },
      settings: { $ref: "#/components/schemas/WidgetSettingsInput" },
    },
  });
  expect(components.schemas?.Widget).toMatchObject({
    properties: {
      settings: { $ref: "#/components/schemas/WidgetSettings" },
    },
  });
  expect(components.schemas?.WidgetSettingsInput).not.toHaveProperty(
    "required",
  );
  expect(components.schemas?.WidgetSettings).toMatchObject({
    required: ["retries"],
  });
});

it("keeps unprefixed names without an explicit direction", async () => {
  const schema = z.object({ id: z.string() }).meta({ ref: "Thing" });
  const result = await toOpenAPISchema(schema);
  expect(result.schema).toEqual({ $ref: "#/components/schemas/Thing" });
  expect(Object.keys(result.components?.schemas ?? {})).toEqual(["Thing"]);
});

it("keeps a wrapper's annotations at the use site when it names a recursive definition", async () => {
  const schema = z.object({
    value: z.json().meta({ ref: "JsonValue", description: "Any JSON value" }),
  });
  const result = await toOpenAPISchema(schema, { io: "output" });
  expect(result.schema.properties?.value).toEqual({
    $ref: "#/components/schemas/JsonValue",
    description: "Any JSON value",
  });
  expect(Object.keys(result.components?.schemas ?? {})).toEqual(["JsonValue"]);
  expect(JSON.stringify(result)).not.toMatch(/Schema_|__schema/);
});

it("rejects a recursive definition given two names", async () => {
  const json = z.json();
  const schema = z.object({
    a: json.meta({ ref: "First" }),
    b: json.meta({ ref: "Second" }),
  });
  await expect(toOpenAPISchema(schema, { io: "output" })).rejects.toThrow(
    'has several names ("First", "Second")',
  );
});

it("rejects an unnamed schema extracted for reuse", async () => {
  const shared = z.object({ id: z.string() });
  const schema = z.object({ a: shared, b: shared });
  await expect(
    toOpenAPISchema(schema, { io: "output", options: { reused: "ref" } }),
  ).rejects.toThrow(
    /Cannot name the reused or recursive schema at #\/\$defs\/__schema0/,
  );
  // Inlining, the default, needs no name.
  expect(
    (await toOpenAPISchema(schema, { io: "output" })).components,
  ).toBeUndefined();
});

it("names nested definitions by their keys without hashing", () => {
  const context: ToOpenAPISchemaContext = { components: {} };
  const result = convertToOpenAPISchema(
    {
      type: "object",
      properties: {
        tree: {
          $defs: {
            Leaf: { type: "string" },
          },
          type: "array",
          items: { $ref: "#/properties/tree/$defs/Leaf" },
        },
      },
    },
    context,
  );
  expect(result).toEqual({
    type: "object",
    properties: {
      tree: { type: "array", items: { $ref: "#/components/schemas/Leaf" } },
    },
  });
  expect(context.components.schemas).toEqual({ Leaf: { type: "string" } });
  expect(() =>
    convertToOpenAPISchema(
      {
        properties: {
          tree: {
            $defs: { __schema0: { type: "string" } },
            items: { $ref: "#/properties/tree/$defs/__schema0" },
          },
        },
      },
      { components: {} },
    ),
  ).toThrow("Cannot name the reused or recursive schema");
});
