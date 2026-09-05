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
