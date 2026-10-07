# Private package artifacts and release gate

Tick remains `@pulse-compute/tick@0.0.0`, `private: true`, experimental and unpublished.
TICK-09 provides a reproducible private review artifact workflow. It does not resolve
the public name, select proven providers, set a release version, create tags/releases,
activate services or publish to npm.

## Prepare a review artifact

From a clean, committed checkout with Node 22+ and installed locked development tools:

```sh
npm ci --no-audit --no-fund
npm test
npm run package:artifact -- --output pkg/NEW_COHORT
```

Choose a fresh single-directory cohort under ignored `pkg/`. The command rejects a dirty
checkout, existing output, another name/version, disabled privacy, or runtime/optional/
peer/bundled dependencies. It rebuilds `dist/`, packs without publishing, checks allowed
files and every declared export, and rechecks committed source. Do not mutate the
checkout concurrently. Incomplete output has no successful manifest; use a new cohort.

The result contains a `.tgz` and `manifest.json` with commit/tree, UTC preparation time,
name/version, byte/file counts, SHA-256 and npm-compatible SHA-512 integrity. The manifest
records **build/pack checks only** and always says `unreleased`, `certified: false`, and
`publicationAuthorized: false`. It does not invent a passing test/live/reviewer verdict.
Retain the successful CI run separately. The package has zero runtime dependencies;
application/proof/signing tools and credentials stay outside the tarball.

`.github/workflows/package-artifact.yml` runs manually on **main only**, executes the
full tests, Node receiver smoke and all five Wasm builds, then uploads the tarball/manifest
as a 30-day Actions artifact. It has read-only repository permissions and no publication
secret or release/tag step. PR CI validates artifact preparation without uploading it.
The workflow must be reviewed/merged before its first main dispatch; this ticket does
not dispatch it. See [GitHub workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data).

After downloading, verify the SHA-256/integrity against the manifest and that the
manifest commit/tree matches the reviewed checkout/run. An Actions artifact is a review
snapshot, not a supported release. Installation uses an explicit local tarball, for example
`npm install /absolute/path/pulse-compute-tick-0.0.0.tgz`; it does not resolve a registry
version. Review both the package and the applicable consumer setup before using it.

## Required later release decision

| Requirement | Current disposition |
| --- | --- |
| Public package name and semantic version | Provisional name; 0.0.0/private retained |
| Independent adversarial review on exact candidate tree | Pending separate reviewer sign-off; implementation audit is recorded in the handoff |
| Trigger/native continuity and host/time assumptions | TICK-01 live gate inconclusive |
| Selected coordination provider's deployed CAS/stale/unknown-write proof | KV/S3 candidates; select only providers whose gate is established |
| Admission and bounded recovery on deployed infrastructure | TICK-05 live gate inconclusive |
| Practical consumer's live effect/read permissions/late-write policy | TICK-08 deployed monitor evidence pending; optional Pulse SDK shim requires its own verification |
| Private artifact contracts/ESM/types/dependency checks and exact candidate CI | Implemented and recorded per run, without production certification |
| Explicit operator approval to publish/tag/release | Not supplied by an ordinary implementation ticket |

Once those decisions/evidence exist, a separate reviewed release change can choose the
name/version, enable publication deliberately, define supported provider/host combinations
and provenance, and request the concrete publication action. Do not infer authorization
from a green local suite, an artifact upload, a `live` label, or merging this PR. Keep
unsupported candidates explicitly labeled and preserve historical inconclusive reports.
