# easy-ssh

A desktop SSH client for the connections you open all the time. Save the host, port, user, and folder, then connect in one click. easy-ssh logs in, `cd`s into that directory, runs any startup commands, and leaves you an interactive shell.

Primary target is Windows. The same app runs on macOS and Linux.

## Features

- Save, edit, delete, and search connections. Optional group, default remote directory, and startup commands (one per line).
- Password auth or a private key file with an optional passphrase.
- One-click connect opens an embedded terminal tab (xterm.js over [ssh2](https://github.com/mscdex/ssh2)). Several tabs can stay open, including more than one session on the same server.
- Host-key prompt the first time you connect, with trust, accept-once, or reject. A changed key is called out before you continue.
- Wrong passwords and dropped connections stay in the tab with reconnect. You can replace a rejected password without editing the whole connection.
- **Open in system terminal** launches the OS terminal with `ssh`. The saved password is not injected; the system `ssh` asks itself (or uses your agent).
- Import and export connections as JSON. Passwords and passphrases are left out of the file.

## Secrets

Connection details (name, host, port, user, key path, directory, commands, group) live in a JSON file under the app data directory. Passwords and key passphrases are encrypted with Electron `safeStorage` before they touch disk. The encryption key stays in the OS keychain:

| OS | Backend |
| --- | --- |
| Windows | DPAPI |
| macOS | Keychain |
| Linux | libsecret (gnome-keyring, KeePassXC, or another Secret Service). The plaintext `basic_text` fallback is refused. |

Typical paths:

- Linux: `~/.config/easy-ssh/connections.json` and `secrets.bin.json`
- macOS: `~/Library/Application Support/easy-ssh/`
- Windows: `%APPDATA%\easy-ssh\`

`secrets.bin.json` holds ciphertext only. Copying it to another machine does not reveal the password.

On Linux, install a secret service and the library Electron uses:

```bash
sudo apt install libsecret-1-0 gnome-keyring
```

Unlock the keyring before starting the app (a normal graphical login does this). If the keychain is unavailable, easy-ssh still opens, but it will not save a password.

## Develop

Node.js 22 or newer.

```bash
npm install
npm run dev
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | Electron with hot reload |
| `npm start` | Preview the production bundle |
| `npm test` | Unit tests for shell quoting and startup commands |
| `npm run typecheck` | Typecheck the main and renderer projects |
| `npm run build` | Compile to `out/` |
| `npm run dist:win` | Windows NSIS installer |
| `npm run dist:mac` | macOS dmg and zip (build this on a Mac) |
| `npm run dist:linux` | AppImage and deb |
| `npm run dist` | Installers for the current platform |

In a container or VM where Chromium’s sandbox cannot start, launch with:

```bash
ELECTRON_DISABLE_SANDBOX=1 npm run dev
```

## Installers

`electron-builder` writes artifacts to `release/`.

- Windows: `release/easy-ssh Setup 1.0.0.exe` (NSIS, per-user, you can choose the directory)
- Linux: `release/easy-ssh-1.0.0.AppImage` and `release/easy-ssh_1.0.0_amd64.deb`
- macOS: `release/easy-ssh-1.0.0.dmg` and a zip, when built on macOS

The deb package depends on `libsecret-1-0` and uses the `homepage` field in `package.json`. The Windows installer does not need an extra keychain; DPAPI is part of Windows.

Code signing is not configured. Windows SmartScreen and macOS Gatekeeper will warn until you sign the build.

## How a connection opens

1. You click the saved server (or **New session** for another shell).
2. easy-ssh checks the host key against `known-hosts.json`. An unknown or changed key waits for your answer.
3. It authenticates with the saved password (or key), then opens a PTY shell.
4. After the login banner settles, it sends `cd` to the default directory and each startup command, then stays interactive.

Startup commands are sent as you typed them. Only the directory path is shell-quoted. A command that fails does not close the shell.

## Keyboard

- `Ctrl/Cmd+N` new connection
- `Ctrl/Cmd+K` focus search
- `Ctrl/Cmd+W` close the active tab when the terminal is not focused
- In the terminal: `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste (`Cmd+C` when there is a selection, `Cmd+V` to paste on macOS). Right-click pastes.
