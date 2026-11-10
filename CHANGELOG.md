# Changelog

Notable changes to easy-ssh, matched to the git tags. `package.json` in the repository stays at the baseline version; the release workflow stamps the version only onto the build.

GitHub release notes are the section for that version. A missing section falls back to generated notes. `[Unreleased]` is not published on its own.

## [Unreleased]

### Fixed

- Keyboard-interactive sign-in no longer replies to every prompt with the saved password. One hidden prompt whose text is a password (and not a one-time code) is filled from the saved password. Any other prompt, including a verification code, OTP, or Duo challenge, opens a dialog. Those answers are not saved. Cancel, closing the tab, or 90 seconds with no answer aborts the connection. Jump hosts use the same rules.

### Added

- GitHub issue forms (bug report and feature request) and a link to https://easyssh.thebetawebsite.com.
- A CI workflow that typechecks and runs the unit tests on pull requests and on pushes to `main`.

### Changed

- README badge links were corrected, and the demo preview is an animated GIF that links to the full video. Those documentation commits are on `main` and are not in a tagged release yet.

## [1.1.3] - 2026-10-29

### Changed

- README rewritten with screenshots, a demo video, and a feature grid.
- Pushes that only change `*.md`, `LICENSE`, or `docs/**` no longer start a release. This tag still published, because `.github/workflows/release.yml` changed in the same commit. The application code is the same as 1.1.2.

## [1.1.2] - 2026-10-29

First release that uploaded a Windows installer (`easy-ssh-Setup-1.1.2.exe`, its blockmap, `latest.yml`, and `easy-ssh-Setup.exe`).

### Fixed

- The release workflow pushes the tag before publishing, uploads every asset in one call (this repository uses immutable releases), and skips tag names GitHub still has reserved.
- v1.1.1 was never published. The earlier attempt published v1.1.0 with no files and an empty body, and left the name v1.1.1 reserved.

The application in this installer is the 1.1.0 tree plus those workflow fixes.

## [1.1.0] - 2026-10-29

Tagged on 2026-10-29. The GitHub release for this tag has no files and an empty body. The commit is the first full application:

### Added

- Saved SSH connections opened in an embedded terminal, with password or private-key authentication and a known-host check.
- File manager on the same connection (SFTP): faster listings and transfers, remote search, a local pane, a resumable transfer queue, bookmarks, and upload after editing a file locally.
- Snippets stored with OS encryption, and a Ctrl+K command palette.
- Optional server stats bar (CPU, memory, disk, uptime).
- Auto-reconnect with capped backoff, and restoring the last session's tabs on launch.
- Theme gallery, collapsible sidebar, split panes, and broadcast input.
- Local, remote, and SOCKS port forwarding.
- Jump hosts, with each hop's host key checked on its own.
- Key manager for ed25519 keys encrypted at rest, and copying a public key to the server.
- Favorites, tags, and import from `~/.ssh/config`.
- Optional per-host tmux session.
- Encrypted backup of connections, snippets, and optionally keys.
- In-app updates from GitHub Releases, and a Windows NSIS build.

### Fixed

- Launch crash caused by importing the CommonJS `ssh2` package as a named ESM export.
- The window could grow a page scrollbar. Terminal panes stay clipped to the viewport, and the status bar stays on one line.
- Command palette keyboard navigation keeps the active row, and its group header, in view.

### Security

- Sandboxed preload, IPC sender checks, stricter input checks, a strict content security policy, and an explicit confirmation when a host key changes.
