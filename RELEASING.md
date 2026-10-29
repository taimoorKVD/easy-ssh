# Releasing easy-ssh

Releases are fully automatic. **Every push to `main` that changes code publishes a new version.**
Docs-only pushes (`*.md`, `LICENSE`) do not release.

- The version is the latest `vX.Y.Z` tag plus one **patch** (1.1.0 → 1.1.1).
- Put `[minor]` or `[major]` in the commit message for a bigger bump (1.1.3 → 1.2.0 / 2.0.0).
- From the Actions tab, **Release → Run workflow** lets you pick patch/minor/major by hand.
- The first release (no tags yet) uses the version in `package.json` (1.1.0).
- If you raise `package.json` above the next computed version, that version is used.
- The version is applied only inside the build; nothing is committed back, so `package.json` in the repo is just the baseline.

The workflow (`.github/workflows/release.yml`, Windows, Node 22) runs `npm ci`, typecheck and tests, builds, then
`electron-builder --win nsis --publish never`, pushes tag `vX.Y.Z`, and creates the published release in one `gh release create` call
(the repo uses immutable releases, so assets cannot be added later) with
`easy-ssh-Setup-X.Y.Z.exe`, its `.blockmap`, `latest.yml` (read by the in-app updater) and
`easy-ssh-Setup.exe`, so `https://github.com/taimoorKVD/easy-ssh/releases/latest/download/easy-ssh-Setup.exe`
always serves the newest installer. Runs are queued (one at a time). Only the built-in `GITHUB_TOKEN` is used.

Installed apps check GitHub 10 s after start and every 6 hours and offer the update.

Builds are not code-signed, so Windows SmartScreen may warn on first install.

Note: v1.1.0 was published empty by the first CI attempt and, being immutable, cannot be fixed; the first real CI release is v1.1.1.
