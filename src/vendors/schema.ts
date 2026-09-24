/** Visit schema keywords only: examples and defaults are JSON data, not schemas. */
export type Schema = boolean | { [key: string]: unknown };

const maps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const singles = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "items",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

export const pointerToken = (value: string) =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");

export function mapSchema(
  schema: Schema,
  visit: (schema: Exclude<Schema, boolean>, path: string) => Schema,
  path = "#",
): Schema {
  if (typeof schema === "boolean") return schema;
  const result = { ...schema };
  for (const [key, value] of Object.entries(schema)) {
    if (!value || typeof value !== "object") continue;
    const childPath = `${path}/${pointerToken(key)}`;
    if (maps.has(key)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          mapSchema(
            child as Schema,
            visit,
            `${childPath}/${pointerToken(name)}`,
          ),
        ]),
      );
    } else if (arrays.has(key) || (key === "items" && Array.isArray(value))) {
      result[key] = (value as Schema[]).map((child, index) =>
        mapSchema(child, visit, `${childPath}/${index}`),
      );
    } else if (singles.has(key)) {
      result[key] = mapSchema(value as Schema, visit, childPath);
    }
  }
  return visit(result, path);
}

/** Stable document-local names keep anonymous definitions from different conversions apart. */
export function schemaName(schema: Schema): string {
  let hash = 2166136261;
  for (const char of JSON.stringify(schema))
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `Schema_${(hash >>> 0).toString(16)}`;
}

/** Discriminator mappings carry references outside the $ref keyword. */
export function mapNodeReferences(
  node: Exclude<Schema, boolean>,
  reference: (value: string) => string,
): Exclude<Schema, boolean> {
  const result = { ...node };
  if (typeof result.$ref === "string") result.$ref = reference(result.$ref);
  const discriminator = result.discriminator as
    | { mapping?: Record<string, string> }
    | undefined;
  if (discriminator?.mapping) {
    result.discriminator = {
      ...discriminator,
      mapping: Object.fromEntries(
        Object.entries(discriminator.mapping).map(([key, value]) => {
          const mapped = reference(value);
          if (mapped !== value || /[#/:]/.test(value)) return [key, mapped];
          const component = `#/components/schemas/${pointerToken(value)}`;
          const target = reference(component);
          return [key, target === component ? value : target];
        }),
      ),
    };
  }
  return result;
}
