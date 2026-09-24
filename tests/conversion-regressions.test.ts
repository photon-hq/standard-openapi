import { expect, it } from "vitest";
import { z } from "zod";
import "zod-openapi/extend";
import { loadVendor, toOpenAPISchema } from "~/index.js";
import { convertToOpenAPISchema } from "~/vendors/convert.js";
import type { ToOpenAPISchemaContext } from "~/vendors/utils.js";

it.each(["parameters", "schemas"] as const)(
  "leaves the caller's components unchanged after a late %s conflict",
  async (kind) => {
    const schema = z.string();
    const vendor = `atomic-components-${kind}`;
    Object.assign(schema["~standard"], { vendor });
    loadVendor(vendor, (_schema, context) => {
      context.components.headers = {
        Fresh: { schema: { type: "string" } },
      };
      context.components.schemas = {
        Fresh: { type: "boolean" },
        Taken: { type: "string" },
      };
      context.components.parameters = {
        Taken: { name: "name", in: "query", schema: { type: "string" } },
      };
      return { type: "string" };
    });
    const components: ToOpenAPISchemaContext["components"] =
      kind === "schemas"
        ? { schemas: { output__Taken: { type: "number" } } }
        : {
            parameters: {
              Taken: { name: "name", in: "query", schema: { type: "number" } },
            },
          };
    const before = structuredClone(components);
    await expect(
      toOpenAPISchema(schema, { io: "output", components }),
    ).rejects.toThrow(
      kind === "schemas"
        ? 'Conflicting schema component "output__Taken"'
        : 'Conflicting parameters component "Taken"',
    );
    expect(components).toEqual(before);
  },
);

it("preserves a nullable Zod 3 reference emitted in OpenAPI 3.0 mode", async () => {
  const schema = z
    .object({ name: z.string() })
    .openapi({ ref: "Person" })
    .nullable();
  expect(schema.safeParse({ name: "Ada" }).success).toBe(true);
  expect(schema.safeParse(null).success).toBe(true);
  expect(schema.safeParse(5).success).toBe(false);
  const result = await toOpenAPISchema(schema, {
    io: "output",
    options: { openapi: "3.0.0" },
  });
  expect(result.schema).toEqual({
    anyOf: [
      { allOf: [{ $ref: "#/components/schemas/output__Person" }] },
      { type: "null" },
    ],
  });
  expect(result.components?.schemas?.output__Person).toMatchObject({
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  });
});

it("preserves constraints and component identity for a type-less nullable definition", () => {
  const context: ToOpenAPISchemaContext = { components: {} };
  const source = {
    $defs: {
      MaybeName: { $id: "MaybeName", enum: ["Ada"], nullable: true },
    },
    $ref: "#/$defs/MaybeName",
  };
  const result = convertToOpenAPISchema(source, context);
  expect(result).toEqual({ $ref: "#/components/schemas/MaybeName" });
  expect(context.components.schemas?.MaybeName).toEqual({
    anyOf: [{ enum: ["Ada"] }, { type: "null" }],
  });
});

it("retains explicit nullable types without duplicating null", () => {
  for (const type of ["string", ["string", "null"]] as const) {
    const source = {
      type: typeof type === "string" ? type : [...type],
      nullable: true,
      minLength: 1,
    };
    expect(convertToOpenAPISchema(source, { components: {} })).toEqual({
      type: ["string", "null"],
      minLength: 1,
    });
  }
});
