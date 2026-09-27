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
  const convert = async (direction: typeof io) => {
    const conversion = {
      components: {},
      options,
      io: direction,
    } satisfies ToOpenAPISchemaContext;
    const converted = await fn(schema, conversion);
    const result = convertToOpenAPISchema(converted, conversion);
    return {
      result,
      components: conversion.components as OpenAPIV3_1.ComponentsObject,
    };
  };
  const { result, components: generated } = await convert(io);
  // Response schemas keep their names. A request schema keeps the same name
  // when its request representation is identical to its response
  // representation, and is named `<Name>Input` when they differ.
  const inputOnly =
    io === "input" && Object.keys(generated.schemas ?? {}).length > 0
      ? inputSpecificSchemas(
          generated.schemas ?? {},
          await convert("output").then(
            ({ components }) => components.schemas ?? {},
            // Without a response representation, treat every request component as request-specific.
            () => null,
          ),
        )
      : new Set<string>();
  const componentName = (name: string) =>
    inputOnly.has(name) ? `${name}Input` : name;
  const targets = Object.keys(generated.schemas ?? {}).map(componentName);
  const clash = targets.find((name, i) => targets.indexOf(name) !== i);
  if (clash)
    throw new Error(
      `standard-openapi: Conflicting schema component "${clash}". Two different definitions use this name; give each a distinct name.`,
    );
  const names = new Map(
    Object.keys(generated.schemas ?? {}).map((name) => [
      `#/components/schemas/${pointerToken(name)}`,
      `#/components/schemas/${pointerToken(componentName(name))}`,
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
              componentName(name),
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
          `standard-openapi: Conflicting ${label} component "${name}". Two different definitions use this name; give each a distinct name.`,
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

/** Serializes JSON with sorted object keys, so key order never matters. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [key, (child as Record<string, unknown>)[key]]),
        )
      : child,
  );

/**
 * Finds the request components whose representation differs from the response
 * representation of the same name. A component that refers to one of them
 * differs too, because the reference target is named differently.
 */
function inputSpecificSchemas(
  input: Record<string, unknown>,
  output: Record<string, unknown> | null,
) {
  if (!output) return new Set(Object.keys(input));
  const differing = new Set(
    Object.entries(input)
      .filter(
        ([name, definition]) =>
          output[name] !== undefined &&
          canonical(output[name]) !== canonical(definition),
      )
      .map(([name]) => name),
  );
  const prefix = "#/components/schemas/";
  const targets = new Map(
    Object.entries(input).map(([name, definition]) => {
      const found = new Set<string>();
      mapSchema(definition as Schema, (node) =>
        mapNodeReferences(node, (ref) => {
          if (ref.startsWith(prefix)) {
            const token = ref.slice(prefix.length).split("/")[0];
            found.add(token.replaceAll("~1", "/").replaceAll("~0", "~"));
          }
          return ref;
        }),
      );
      return [name, found];
    }),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, found] of targets) {
      if (differing.has(name)) continue;
      if ([...found].some((target) => differing.has(target))) {
        differing.add(name);
        changed = true;
      }
    }
  }
  return differing;
}

/**
 * Load vendor before calling toOpenAPISchema,
 * for imporving performance and adding support for unsupported vendors
 */
export function loadVendor(vendor: string, fn: ToOpenAPISchemaFn) {
  openapiVendorMap.set(vendor, fn);
}
