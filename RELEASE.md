# Releasing

`release.yml` publishes on `v*` tags via **OIDC trusted publishing** — no
token secret. One-time setup on npmjs.com (package Settings → Trusted
Publisher): repository `kilden-sdk-node`, workflow `release.yml`.

## Cutting a release

1. Bump `version` in `package.json` (and `src/version.ts`).
2. Update `CHANGELOG.md`.
3. `git tag v0.1.0-alpha.2 && git push origin v0.1.0-alpha.2`.

Prerelease tags (`-alpha`/`-beta`/`-rc`) publish under the npm dist-tag
`alpha`; anything else under `latest`.

Manual fallback: `npm publish --access public --tag alpha --otp=<code>`.
