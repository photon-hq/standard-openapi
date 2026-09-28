import type { JSONSchema7 } from "json-schema";
import type { OpenAPIV3_1 } from "openapi-types";
import {
  mapNodeReferences,
  mapSchema,
  pointerToken,
  type Schema,
} from "./schema.js";
import type { ToOpenAPISchemaContext } from "./utils.js";

/** Vendors such as Zod 4 give unnamed reused or recursive schemas generated keys. */
const isGeneratedName = (name: string) => name.startsWith("__schema");

export function convertToOpenAPISchema(
  jsonSchema: JSONSchema7 | OpenAPIV3_1.SchemaObject,
  context: ToOpenAPISchemaContext,
): OpenAPIV3_1.SchemaObject | OpenAPIV3_1.ReferenceObject {
  const source = jsonSchema as Schema;
  const locations = new Map<string, string>();
  // Unnamed definitions, keyed by location, with the named nodes that wrap them.
  const unnamed = new Map<string, { names: Set<string> }>();
  const named: { path: string; name: string; ref: unknown }[] = [];
  const uses = new Map<string, string>();
  const booleans = new Map<string, boolean>();

  mapSchema(source, (schema, path) => {
    const name = schema.ref ?? schema.$id;
    if (typeof name === "string") {
      locations.set(path, name);
      named.push({ path, name, ref: schema.$ref });
    }
    for (const key of ["definitions", "$defs"]) {
      for (const [name, definition] of Object.entries(schema[key] ?? {})) {
        const location = `${path}/${key}/${pointerToken(name)}`;
        if (typeof definition === "boolean") booleans.set(location, definition);
        // A definition's own `ref`/`$id` metadata names it. Otherwise its key
        // is the name, unless the vendor generated that key.
        if (locations.has(location)) continue;
        if (isGeneratedName(name)) unnamed.set(location, { names: new Set() });
        else locations.set(location, name);
      }
    }
    if (typeof schema.$ref === "string" && !uses.has(schema.$ref))
      uses.set(schema.$ref, path);
    return schema;
  });

  // A named schema that only points at a generated definition (for example
  // `z.json().meta({ ref: "JsonValue" })`) lends that definition its name.
  // The wrapper then stays a reference at its use site.
  // Alias location → the generated definition it points at.
  const aliases = new Map<string, string>();
  for (const { path, name, ref } of named) {
    const definition = typeof ref === "string" ? unnamed.get(ref) : undefined;
    if (!definition) continue;
    definition.names.add(name);
    aliases.set(path, ref as string);
  }
  for (const [location, { names }] of unnamed) {
    if (names.size === 1) {
      locations.set(location, [...names][0]);
      continue;
    }
    const use = uses.get(location);
    throw new Error(
      names.size === 0
        ? `standard-openapi: Cannot name the reused or recursive schema at ${location}${use ? ` (referenced from ${use})` : ""}. Name it with metadata, for example .meta({ ref: "Name" }), so it becomes a named component.`
        : `standard-openapi: The reused or recursive schema at ${location} has several names (${[...names].map((name) => `"${name}"`).join(", ")}). Use one name for it.`,
    );
  }
  for (const path of aliases.keys()) locations.delete(path);
  // A reference to an alias's own location (for example a `$defs` entry that
  // Zod 4 emits for the wrapper) points at the named target instead.
  const resolve = (ref: string) => aliases.get(ref) ?? ref;
  // A local pointer outside every named definition refers into the root, so
  // the root must be a named component too.
  if (!locations.has("#")) {
    for (const [alias, use] of uses) {
      const ref = resolve(alias);
      if (
        (ref === "#" || ref.startsWith("#/")) &&
        !ref.startsWith("#/components/") &&
        ![...locations.keys()].some(
          (path) => ref === path || ref.startsWith(`${path}/`),
        )
      )
        throw new Error(
          `standard-openapi: Cannot name the recursive root schema (referenced from ${use}). Name it with metadata, for example .meta({ ref: "Name" }), so it becomes a named component.`,
        );
    }
  }
  for (const [location, definition] of booleans) {
    context.components.schemas ??= {};
    const name = locations.get(location)!;
    const existing: unknown = context.components.schemas[name];
    if (existing !== undefined && existing !== definition)
      throw new Error(
        `standard-openapi: Conflicting schema component "${name}". Two different schemas use this name; give each a distinct name.`,
      );
    context.components.schemas[name] =
      definition as unknown as OpenAPIV3_1.SchemaObject;
  }

  const reference = (original: string): string => {
    const ref = resolve(original);
    if (ref.startsWith("#/components/")) return ref;
    const location = [...locations.keys()]
      .filter((path) => ref === path || ref.startsWith(`${path}/`))
      .sort((a, b) => b.length - a.length)[0];
    return location
      ? `#/components/schemas/${pointerToken(locations.get(location)!)}${ref.slice(location.length)}`
      : ref;
  };

  return mapSchema(source, (schema, path) => {
    let result = mapNodeReferences(schema, reference);
    delete result.$schema;
    delete result.$defs;
    delete result.definitions;
    const name = locations.get(path);
    if (name || aliases.has(path)) {
      delete result.ref;
      delete result.$id;
    }
    if (result.nullable === true) {
      delete result.nullable;
      if (result.type === undefined) {
        result = { anyOf: [result, { type: "null" }] };
      } else {
        const types = Array.isArray(result.type) ? result.type : [result.type];
        result.type = [...new Set([...types, "null"])];
      }
    }
    if (name) {
      context.components.schemas ??= {};
      const componentRef = `#/components/schemas/${pointerToken(name)}`;
      // A metadata vendor can already have emitted the real component.
      if (
        !(
          Object.keys(result).length === 1 &&
          result.$ref === componentRef &&
          context.components.schemas[name]
        )
      ) {
        const existing = context.components.schemas[name];
        if (
          existing !== undefined &&
          JSON.stringify(existing) !== JSON.stringify(result)
        ) {
          throw new Error(
            `standard-openapi: Conflicting schema component "${name}". Two different schemas use this name; give each a distinct name.`,
          );
        }
        context.components.schemas[name] = result;
      }
      return { $ref: componentRef };
    }
    return result;
  }) as OpenAPIV3_1.SchemaObject;
}
