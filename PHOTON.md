# Photon package

`@photon-hq/standard-openapi` is published to GitHub Packages.

Version `0.2.9-photon.1` uses upstream commit
`e6d36ac64d93b4a70e39f9d6972ddcb3ce854faf`, which includes
[standard-community/standard-openapi#14](https://github.com/standard-community/standard-openapi/pull/14).
That fix moves recursive definitions into `components.schemas` even when the
root schema is a container rather than a reference. No Photon converter patch
is applied. A regression test covers the recursive Zod JSON record used by
webhooks.

To publish a new version, update `package.json`, merge the change to `main`,
then run the **Publish GitHub Package** workflow. Versions are immutable;
increment the `-photon.N` suffix for Photon changes to the same upstream version.
The workflow publishes with its repository's `GITHUB_TOKEN`.

Keep the upstream MIT license. Compare this fork with the next upstream release
before updating its base or switching consumers back to the upstream package.

## Request and response conversion (ENG-2960)

Pass `io: "input"` for request schemas and `io: "output"` for schemas describing
serialized JSON responses. This is a top-level conversion context field:

```ts
await toOpenAPISchema(schema, { io: "input" });
await toOpenAPISchema(schema, { io: "output" });
```

Zod 4 receives `io`, Zod 3's `zod-openapi` receives `schemaType`, and Valibot
receives `typeMode`. Custom vendors receive `context.io` and must forward it
using their converter's supported API. Other vendors retain their existing
conversion behavior; the context does not invent a representation for arbitrary
runtime transformations. Supply an explicit JSON output schema for those.
Without explicit direction, the existing Zod input default is retained.

Explicit direction scopes generated component names as `input__Name` and
`output__Name`. Anonymous recursive components have deterministic document-local
names. References are relocated with their pointer suffixes and sibling
constraints intact; external references and example/default data are preserved.
Callers must follow the emitted references rather than relying on anonymous
component names. Conflicting definitions fail instead of overwriting one another.

Direction does not make strict objects open or change a typed catchall to `any`.
Response extensibility and choice of reader versus producer contracts remain
service-owned decisions (ENG-2962 / ENG-2963).

### Known Zod 3 limitation (approved CI exception)

Tracked in [ENG-2960](https://linear.app/photonhq/issue/ENG-2960).
Zod 3 support and its existing behavior remain available. This release has one
approved expected-failure assertion in `tests/input-output.test.ts` for the
existing Zod 3 output-conversion defect; it does not repair runtime behavior.
The locked `zod-openapi@4.2.3`, and latest compatible stable `4.2.4`, omit
`additionalProperties: false` for a stripping `z.object` in output mode. For
`z.object({ name: z.string().default("Ada") })`, parsing `{ extra: true }`
produces `{ name: "Ada" }`; output conversion makes `name` required but leaves
the object open. This is existing dependency behavior, also reproducible by
calling `createSchema` directly with `schemaType: "output"`.

The supported options do not correct this. Latest stable `zod-openapi@6.0.2`
requires Zod 4 and is not a compatible Zod 3 upgrade. Related upstream context:
https://github.com/samchungy/zod-openapi/issues/528 and
https://github.com/samchungy/zod-openapi/pull/405 (passthrough only).
The exception covers only the assertion that a stripping Zod 3 output object
has `additionalProperties: false`. Conversion runs in a normal `beforeAll`
hook; conversion errors still fail CI. Parsing, defaults, input behavior and
output requiredness remain ordinary required tests. Zod 4 checks remain required
without exceptions. The named `KNOWN LIMITATION` test runs with `it.fails` rather
than being skipped: an unexpected pass fails CI and requires removing the marker.

Remove this exception when a compatible upstream dependency fix makes the
assertion pass, then rerun the full suite. No downstream schema repair or support
removal is included. A green suite therefore qualifies the selected Photon Zod 4
path while retaining this explicit Zod 3 limitation; it does not establish that
all supported Zod 3 output schemas are accurate.

Version `0.2.9-photon.2` contains these changes and has not been published yet.
Release this package first, then pin that exact version in hono-openapi and
verify that package before releasing the chassis and adopting it in services.
