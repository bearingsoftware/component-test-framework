# Publishing

Releases from `main` are handled by release-please + GitHub Actions and go to GitHub Packages (`publishConfig.registry` in `package.json`).

For iterating on the framework before merging, `npm run pub` publishes a snapshot build to the local Verdaccio at `http://localhost:4873`:

```bash
# one-time, per machine
npm adduser --registry http://localhost:4873

# on any non-main branch
npm run pub
```

The wrapper mutates `package.json` to a snapshot version like `0.1.0-snapshot.<branch-slug>.<utc-timestamp>.<sha7>`, publishes to Verdaccio with dist-tag `snapshot`, and restores `package.json` afterwards. If the publish aborts and leaves `package.json.orig` on disk, run `npm run publish:restore` to recover.

Consumers opt in by adding a project-level `.npmrc`:

```
@bearingsoftware:registry=http://localhost:4873
```

then `npm install @bearingsoftware/component-test-framework@snapshot` for the latest snapshot, or pin to an exact snapshot version for reproducibility.
