# Package artifacts and manual npm publishing

The development checkout remains `@pulse-compute/tick@0.0.0`, `private: true`.
The manual npm workflow prepares a separate versioned public tarball from clean committed
source. Adding or merging the workflow does not dispatch publication or certify a provider.
No push, PR, tag or GitHub release publishes automatically.

## CI

`Tick CI` runs `npm run check` on Node 22 and 24 for PRs and main. It covers all tests,
strict contract types, packed ESM/TypeScript consumers, the README example and Node smoke.
It does not compile Wasm on PRs. `Tick contracts and proof` builds all five Wasm guests
on main and manual dispatch; private artifact and npm workflows also build all five.

To require a green gate before merging, configure main's branch protection/ruleset to
require **Check (Node 22)** and **Check (Node 24)**, with branches up to date. Workflow
files supply the checks; they do not change repository protection settings.

## Prepare a private review artifact

From a clean committed checkout with Node 22+ and installed locked development tools:

```sh
npm ci --no-audit --no-fund
npm run check
npm run package:artifact -- --output pkg/NEW_COHORT
```

Choose a fresh single-directory cohort under ignored `pkg/`. Preparation rejects dirty
source, existing output, another source name/version, disabled source privacy, and runtime,
optional, peer or bundled dependencies. It builds, packs with lifecycle scripts disabled,
checks allowed files and exports, then rechecks the source commit/tree.

The result contains a `.tgz` and `manifest.json` with commit/tree, preparation time,
name/version, file/byte counts, SHA-256 and npm-compatible SHA-512 integrity. A private
manifest always says `unreleased`, `certified: false`, `publicationAuthorized: false`.
It records build/pack checks only; retain the applicable CI run separately.

The manual **Private Tick package artifact** workflow runs on main only, validates and
uploads a 30-day Actions artifact. It uses read-only repository permissions and no npm
credentials. Install its tarball directly with
`npm install /absolute/path/to/pulse-compute-tick-0.0.0.tgz`.

## Configure npm authentication

The workflow filename is **npm-publish.yml**; package name is **@pulse-compute/tick**.
It uses a GitHub-hosted runner, Node 24 and npm >=11.5.1, with `id-token: write` on the
publish job. Configure the npm trusted publisher with:

| npm field | Value |
| --- | --- |
| Organization/user | `pulse-compute` |
| Repository | `tick` |
| Workflow filename | `npm-publish.yml` |
| Environment | `npm` |
| Allowed action | Direct `npm publish` |

Create the GitHub **npm** environment. If package bootstrap or token authentication is
needed, supply a suitably scoped granular **NPM_TOKEN** environment secret with publish
access to this package and an appropriate 2FA policy. It is exposed only to the final
publish step. npm prefers configured OIDC and can fall back to that token. Keep credentials
out of source, workflow inputs and logs. After bootstrap, configure trusted publishing
and remove a fallback token that is no longer needed.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for current
configuration requirements. The source repository is private, so npm provenance is
explicitly disabled; the workflow does not claim provenance attestations. The artifact
still records exact committed source and tarball hashes.

## Run the manual publish workflow

After the reviewed workflow is merged, open Actions → **Publish Tick to npm** → Run workflow.
Select **main** and supply:

| Input | Example / behavior |
| --- | --- |
| `version` | Exact SemVer, such as `0.1.0-beta.1`; no `v`, range or build metadata |
| `tag` | `beta` by default; `next` and `latest` also available |
| `dry_run` | `true` by default; `false` explicitly enables the final npm upload |

Prereleases cannot use `latest`. The source version remains 0.0.0; the selected version
exists only in the staged artifact. Release preparation removes source privacy, development
dependencies and lifecycle scripts from that artifact, sets explicit public registry/access/
tag metadata, and leaves every other packed byte unchanged. The source must remain clean
and at the original commit/tree through preparation.

The workflow validates inputs, installs locked tools without an npm cache, runs all local
checks and five Wasm builds, prepares the tarball, uploads tarball/manifest for 30 days,
and executes `npm publish --dry-run` against that exact tarball. Only `dry_run: false`
runs the final `npm publish`, using the same file, explicit tag and public access.
Concurrent publishing runs are serialized. It does not commit version bumps, create tags,
create GitHub releases or deploy services. Review the Actions run SHA and selected version
before dispatching a real publish; a successful dry run does not check publish authorization
or prove that the name/version is available. Existing npm versions cannot be overwritten.
A rerun prepares fresh output, but attempting the same already-published version fails.

For local preparation without publishing (GNU/BSD `tar` must be available):

```sh
RELEASE_VERSION=0.1.0-beta.1 RELEASE_TAG=beta \
  npm run package:release -- --output pkg/release-preview
npm publish pkg/release-preview/*.tgz --dry-run --ignore-scripts --access public --tag beta
```

Download the artifact and verify its hashes and source commit/tree against `manifest.json`
and the reviewed run. The release manifest says `prepared`, `published: false`,
`certified: false`; it describes preparation and is not a fabricated npm registry receipt.
After publication, verify the exact registry version and integrity in the workflow logs
or with `npm view @pulse-compute/tick@VERSION version dist.integrity`.

## Proof status is separate from publishing mechanics

| Requirement | Current disposition |
| --- | --- |
| Independent adversarial review on exact candidate tree | Separate reviewer sign-off remains pending |
| Trigger/native continuity and host/time assumptions | TICK-01 live gate inconclusive |
| Selected provider's deployed CAS/stale/unknown-write proof | KV/S3 candidate gates remain inconclusive |
| Admission and bounded recovery on deployed infrastructure | TICK-05 live gate inconclusive |
| Practical consumer's permissions and late-write behavior | TICK-08 deployed evidence pending; optional Pulse shim is not verified SDK integration |
| Local contracts/ESM/types/zero-runtime-dependency checks | Recorded by exact candidate CI; not production certification |
| Publication | Maintainer explicitly dispatches with `dry_run: false`; no publish was performed to add this workflow |

Keep experimental provider/host claims and historical inconclusive reports intact when
publishing a preview. A green workflow or an npm package does not close a deployed proof
gate. See [operations](operations.md) and the
[adversarial review handoff](https://github.com/pulse-compute/tick/blob/main/proof/hardening/REVIEW.md).
