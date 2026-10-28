# Releasing

`pi-cohort-mux`, `pi-cohort-mux-cmux`, and `pi-cohort-mux-herdr` release in
lockstep: one version, one curated `CHANGELOG.md` section, and one immutable
`v<version>` tag. The adapters depend on the exact `pi-cohort-mux` version
they ship with.

Pushing a matching tag runs `.github/workflows/publish.yml`, which stages all
three packages through npm trusted publishing (`npm stage publish`), the
shared mechanics first, then creates a GitHub Release from the matching
`CHANGELOG.md` section.

Staging defers publication to a human: the tag push never makes a version
installable by itself. After the workflow succeeds, approve each staged
package on npmjs.com (or with `npm stage approve <stage-id>`, which requires
2FA) to publish it. Approve `pi-cohort-mux` first: until it is live, the
adapters that pin it cannot install. The GitHub Release is created when
staging succeeds, so it can exist briefly before npm approval.

The workflow uses GitHub's OIDC identity and does not require an npm token. It
uses the npm version bundled with Node 26 and fails before staging if that
version is older than the staged-publishing minimum (npm 11.15.0).

## Prepare a release

1. Add a nonempty `## [<version>] - YYYY-MM-DD` section to `CHANGELOG.md`.
2. Set `version` to `<version>` in each `packages/*/package.json`, and each
   adapter's `pi-cohort-mux` dependency to the same exact version. Refresh the
   lockfile:

   ```bash
   npm install
   ```

3. Run the release checks locally:

   ```bash
   npm ci
   npm run check
   npm run pack:check
   node scripts/extract-release-notes.mjs <version>
   ```

4. Merge the version and changelog change after CI passes.
5. Verify the intended commit, then create and push an annotated `v<version>`
   tag at that exact commit.

The tag push starts the publish workflow. Before staging anything, it rejects a
tag that differs from the packages' shared version, packages whose versions
differ, an adapter that pins another `pi-cohort-mux` version, a tag that does
not point at the checked-out commit, and a missing or empty changelog section.
After staging succeeds, it creates the corresponding GitHub Release using only
that version's changelog section; each package goes live on npm only when a
maintainer approves its stage.

Do not move or reuse a pushed release tag. If a release fails after its tag is
pushed, including when only some packages staged, reject any stages that
succeeded, fix the problem, and release a new version.

## Initial release

The first publication registers the package names before npm trusted
publishing can be configured, because trusted publishing must reference an
existing package. Perform the bootstrap in this order:

1. Merge the reviewed packaging and release setup.
2. Publish the first version of each package manually from the exact merged
   commit, `pi-cohort-mux` first, using a short-lived credential held only in
   memory or a secrets manager. Do not write the credential to disk or check it
   into the repository.

   ```bash
   npm publish --workspace <package> --access public --provenance=false
   ```

   The first local publication cannot carry GitHub Actions provenance. This
   override disables `publishConfig.provenance` only for the bootstrap; later
   OIDC releases publish with provenance.

3. With the packages now registered, configure npm trusted publishing on each
   of the three packages for this exact repository and the `publish.yml`
   workflow filename. Allow only `npm stage publish` on each trust
   relationship; keep `npm publish` disabled so every release requires human
   approval.
4. Revoke the short-lived bootstrap credential.

After the bootstrap, every future release publishes through OIDC by pushing an
approved immutable `v<version>` tag as described above. Do not push the initial
version's tag in a way that reruns publication for a version that was already
published manually.
