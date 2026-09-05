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

it("resolves every reference in an unnamed recursive JSON record", async () => {
  const result = await toOpenAPISchema(z.record(z.string(), z.json()));
  const references = localReferences(result);

  expect(references.length).toBeGreaterThan(0);
  expect(result.schema).toMatchObject({ type: "object" });
  expect(result.schema).not.toHaveProperty("$defs");
  expect(result.schema).not.toHaveProperty("definitions");

  for (const reference of references) {
    const path = reference
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    expect(result).toHaveProperty(path);
  }
});
