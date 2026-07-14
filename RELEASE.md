# Releasing

Two paths; both need an npm account with publish rights in the `kilden-io`
org (2FA required).

## Manual (first release)

```sh
npm run check
npm publish --access public --tag alpha --otp=<code>   # prereleases
git tag v0.1.0-alpha.1 && git push origin v0.1.0-alpha.1
```

`npm publish --dry-run` is green as of 0.1.0-alpha.1; the only missing piece
is the 2FA one-time password.

## CI (tags)

`release.yml` publishes on `v*` tags using the `NPM_TOKEN` repository secret
(an automation token, which skips the OTP). Set the secret once:

```sh
gh secret set NPM_TOKEN --repo freshworkstudio/kilden-sdk-node
```

Then a plain `git push origin v0.1.0` releases: prerelease tags
(`-alpha/-beta/-rc`) get the npm dist-tag `alpha`, everything else `latest`.
