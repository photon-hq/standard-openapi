import { expect, it } from "vitest";
import z from "zod/v4";
import { toOpenAPISchema } from "~/index.js";

function localReferences(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, child]) => {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
      return [child];
    }
    return localReferences(child);
  });
}

it("names a recursive JSON value from its metadata and resolves every reference", async () => {
  const result = await toOpenAPISchema(
    z.record(z.string(), z.json().meta({ ref: "JsonValue" })),
  );
  const references = localReferences(result);

  expect(result.schema).toEqual({
    type: "object",
    propertyNames: { type: "string" },
    additionalProperties: { $ref: "#/components/schemas/JsonValue" },
  });
  expect(Object.keys(result.components?.schemas ?? {})).toEqual(["JsonValue"]);
  expect(result.components?.schemas?.JsonValue).toMatchObject({
    anyOf: expect.arrayContaining([
      { type: "array", items: { $ref: "#/components/schemas/JsonValue" } },
    ]),
  });
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    expect(reference).toBe("#/components/schemas/JsonValue");
    const path = reference
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    expect(result).toHaveProperty(path);
  }
});

it("rejects an unnamed recursive JSON value instead of inventing a name", async () => {
  await expect(toOpenAPISchema(z.record(z.string(), z.json()))).rejects.toThrow(
    /Cannot name the reused or recursive schema at #\/\$defs\/__schema0 \(referenced from #\/additionalProperties\)\. Name it with metadata/,
  );
});
