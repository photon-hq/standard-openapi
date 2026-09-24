import type { JSONSchema7 } from "json-schema";
import type { OpenAPIV3_1 } from "openapi-types";
import {
  mapNodeReferences,
  mapSchema,
  pointerToken,
  type Schema,
  schemaName,
} from "./schema.js";
import type { ToOpenAPISchemaContext } from "./utils.js";

export function convertToOpenAPISchema(
  jsonSchema: JSONSchema7 | OpenAPIV3_1.SchemaObject,
  context: ToOpenAPISchemaContext,
): OpenAPIV3_1.SchemaObject | OpenAPIV3_1.ReferenceObject {
  const source = jsonSchema as Schema;
  const locations = new Map<string, string>();
  const documentName = schemaName(source);
  let needsRoot = false;

  mapSchema(source, (schema, path) => {
    const name = schema.ref ?? schema.$id;
    if (typeof name === "string") locations.set(path, name);
    for (const key of ["definitions", "$defs"]) {
      for (const [name, definition] of Object.entries(schema[key] ?? {})) {
        const location = `${path}/${key}/${pointerToken(name)}`;
        // Named definitions remain readable. Vendor-generated names are local
        // to one conversion and cannot be shared across unrelated schemas.
        if (!locations.has(location))
          locations.set(
            location,
            path !== "#"
              ? `${documentName}_${schemaName({ location })}_${name}`
              : name.startsWith("__schema")
                ? `${documentName}_${name}`
                : name,
          );
        if (typeof definition === "boolean") {
          context.components.schemas ??= {};
          context.components.schemas[locations.get(location)!] =
            definition as unknown as OpenAPIV3_1.SchemaObject;
        }
      }
    }
    if (
      typeof schema.$ref === "string" &&
      (schema.$ref === "#" ||
        (schema.$ref.startsWith("#/") &&
          !schema.$ref.startsWith("#/$defs/") &&
          !schema.$ref.startsWith("#/definitions/") &&
          !schema.$ref.startsWith("#/components/")))
    )
      needsRoot = true;
    return schema;
  });
  if (needsRoot && !locations.has("#")) locations.set("#", documentName);

  const reference = (ref: string): string => {
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
    if (name) {
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
            `standard-openapi: Conflicting schema component "${name}".`,
          );
        }
        context.components.schemas[name] = result;
      }
      return { $ref: componentRef };
    }
    return result;
  }) as OpenAPIV3_1.SchemaObject;
}
