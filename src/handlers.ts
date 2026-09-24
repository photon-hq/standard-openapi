import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { OpenAPIV3_1 } from "openapi-types";
import { convertToOpenAPISchema } from "./vendors/convert.js";
import { getToOpenAPISchemaFn } from "./vendors/index.js";
import {
  mapNodeReferences,
  mapSchema,
  pointerToken,
  type Schema,
} from "./vendors/schema.js";
import {
  openapiVendorMap,
  type ToOpenAPISchemaContext,
  type ToOpenAPISchemaFn,
} from "./vendors/utils.js";

/**
 * Converts a Standard Schema to a OpenAPI schema.
 */
export const toOpenAPISchema = async (
  schema: StandardSchemaV1,
  context: Partial<ToOpenAPISchemaContext> = {},
) => {
  const fn = await getToOpenAPISchemaFn(schema["~standard"].vendor);

  const { components = {}, options } = context;
  const io =
    context.io ??
    (options?.io === "input" || options?.io === "output"
      ? options.io
      : undefined);
  // Vendors get a fresh component map; a reused schema cannot change a
  // definition already emitted for the opposite side of an operation.
  const conversion = {
    components: {},
    options,
    io,
  } satisfies ToOpenAPISchemaContext;
  const converted = await fn(schema, conversion);
  const result = convertToOpenAPISchema(converted, conversion);
  const generated: OpenAPIV3_1.ComponentsObject = conversion.components;
  const names = new Map(
    Object.keys(generated.schemas ?? {}).map((name) => [
      `#/components/schemas/${pointerToken(name)}`,
      `#/components/schemas/${pointerToken(io ? `${io}__${name}` : name)}`,
    ]),
  );
  const reference = (ref: string) => {
    const end = ref.indexOf("/", "#/components/schemas/".length);
    const component = end === -1 ? ref : ref.slice(0, end);
    const target = names.get(component);
    return target ? target + ref.slice(component.length) : ref;
  };
  const rewrite = (value: Schema) =>
    mapSchema(value, (node) => mapNodeReferences(node, reference));
  const rewriteComponent = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteComponent);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "schema") return [key, rewrite(child as Schema)];
        if (key === "$ref" && typeof child === "string")
          return [key, reference(child)];
        if (
          ["example", "examples", "value"].includes(key) ||
          key.startsWith("x-")
        )
          return [key, child];
        return [key, rewriteComponent(child)];
      }),
    );
  };
  // Prepare and check every definition before changing the caller's map.
  // A conflict in a later kind or schema must leave the document unchanged.
  const pending: Record<string, Record<string, unknown>> = {};
  for (const [kind, values] of Object.entries(generated)) {
    pending[kind] =
      kind === "schemas"
        ? Object.fromEntries(
            Object.entries(values ?? {}).map(([name, value]) => [
              io ? `${io}__${name}` : name,
              rewrite(value as Schema),
            ]),
          )
        : (rewriteComponent(values) as Record<string, unknown>);
  }
  for (const [kind, definitions] of Object.entries(pending)) {
    const existing = components[kind as keyof typeof components];
    for (const [name, definition] of Object.entries(definitions)) {
      if (
        existing?.[name] !== undefined &&
        JSON.stringify(existing[name]) !== JSON.stringify(definition)
      ) {
        const label = kind === "schemas" ? "schema" : kind;
        throw new Error(
          `standard-openapi: Conflicting ${label} component "${name}".`,
        );
      }
    }
  }
  const rewrittenSchema = rewrite(result as Schema) as OpenAPIV3_1.SchemaObject;
  for (const [kind, definitions] of Object.entries(pending)) {
    const existing = components[kind as keyof typeof components];
    Object.assign(components, { [kind]: { ...existing, ...definitions } });
  }
  return {
    schema: rewrittenSchema,
    components: Object.keys(components).length > 0 ? components : undefined,
  };
};

/**
 * Load vendor before calling toOpenAPISchema,
 * for imporving performance and adding support for unsupported vendors
 */
export function loadVendor(vendor: string, fn: ToOpenAPISchemaFn) {
  openapiVendorMap.set(vendor, fn);
}
