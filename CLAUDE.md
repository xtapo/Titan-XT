# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

Four workspaces, each with its own `package.json` — there is no top-level node_modules. The root [package.json](package.json) only has cross-workspace shortcuts.

- [app/](app/) — Electron desktop app (host + viewer in one binary)
- [server/](server/) — Signal server (Express + Socket.io)
- [web-viewer/](web-viewer/) — PWA viewer (mobile/iPad/desktop browser)
- [extension/](extension/) — Chrome MV3 quick-connect extension (vanilla JS, no build)

## Common commands

All commands run inside their workspace directory.

| Workspace | Dev | Build | Notes |
|---|---|---|---|
| `app` | `npm run dev` | `npm run build` | Dev = TS watch (main) + Vite (renderer) + electron, all via `concurrently` |
| `server` | `npm run dev` | `npm run build` | `tsx watch` for dev |
| `web-viewer` | `npm run dev` | `npm run build` | Vite with `--host` so phones on LAN can reach it |

App packaging (run in `app/`):

- `npm run package:win` / `package:mac` / `package:linux` — local build
- `npm run release:win` / `release:mac` — build + publish to GitHub Releases (needs `GH_TOKEN`)

There is no test runner or linter wired up. "Verify the build" means `npm run build` in the affected workspace.

## High-level architecture

### One binary, three roles

[app/src/main/index.ts](app/src/main/index.ts) is a thin dispatcher that picks one of three roles before any Electron code loads:

- **Agent** (default) — Electron UI process, runs in the user session. Lives in [app/src/main/agent.ts](app/src/main/agent.ts).
- **Service** (`--service`) — LocalSystem supervisor started by a Scheduled Task at boot. Lives in [app/src/service/](app/src/service/). Watches the active console session and (re)spawns the worker into it.
- **Worker** (`--worker --session=N`) — SYSTEM-level input + system-actions executor inside the active interactive desktop. Lives in [app/src/worker/index.ts](app/src/worker/index.ts).

Why: the Worker needs LocalSystem privileges to drive UAC-elevated foreground apps without UIPI blocking input simulation. The Agent IPCs to it over a per-session named pipe, falling back to in-process execution when the pipe isn't available (dev runs, non-elevated targets).

The dispatcher reason: Service/Worker paths must not pull in Electron — `ELECTRON_RUN_AS_NODE=1` is set when spawning the worker so the Electron binary runs as plain Node. See the comment block at the top of [app/src/service/service-host.ts](app/src/service/service-host.ts) for why we use a Scheduled Task instead of a real SCM service.

### Wire protocols (two separate ones)

- **Agent ↔ Worker (local)**: newline-delimited JSON over a Windows named pipe. Defined in [app/src/shared/pipe-protocol.ts](app/src/shared/pipe-protocol.ts). Pipe path is per-session: `\\.\pipe\titan-xt-input-<sessionId>`.
- **Peer ↔ Peer (network)**: WebRTC data channels named `input`, `chat`, `file`, `system`, `annotation`. Message types defined in [app/src/shared/protocol.ts](app/src/shared/protocol.ts). The signal server only relays SDP/ICE — it never sees session data.

Both the Electron app and the web viewer speak the same WebRTC protocol — the host can't tell whether the peer is Electron or a browser. Web viewer's [web-viewer/src/protocol.ts](web-viewer/src/protocol.ts) is a subset of [app/src/shared/protocol.ts](app/src/shared/protocol.ts); when adding fields to a message type, update both.

### Authentication is challenge-response

Password (4 chars) never leaves the host. Viewer requests a connection → host generates a nonce → viewer hashes `SHA256(password + nonce)` → host verifies. The signal server only relays the request and the SDP/ICE that follow. See [server/src/signaling.ts](server/src/signaling.ts) and [web-viewer/src/sha256.ts](web-viewer/src/sha256.ts).

### Renderer entry points

[app/src/renderer/main.ts](app/src/renderer/main.ts) bootstraps the UI and creates a single `ConnectionManager` ([app/src/renderer/lib/connection.ts](app/src/renderer/lib/connection.ts)) on `window.connectionManager` — pages and components reach into it from there. The renderer has no framework, just vanilla TS + CSS modules per page.

### Chromium codec flags

[app/src/main/agent.ts](app/src/main/agent.ts) appends a list of `--enable-features` switches to the Electron command line **before** `app.whenReady()` to enable H.265, AV1, hardware encode (NVENC/QuickSync/VideoToolbox/VAAPI), Windows Graphics Capture, and zero-copy capture. Without these, Chromium quietly falls back to software x264 and the codec-preference toggle in the UI does nothing. If you change the flag list, test on a host without HEVC hardware to confirm the runtime probe in [app/src/shared/constants.ts](app/src/shared/constants.ts) still gates the toggle correctly.

## Release flow

### Bumping versions

When the user asks to release/publish/cut a tag, bump `app/package.json` first — see memory `auto-bump-version-on-release`. Pick the bump level by intent (patch/minor/major) unless they name a version.

```bash
cd app && npm version <new-version> --no-git-tag-version
git add app/package.json
git commit -m "release: vX.Y.Z - <one-line summary>"
git tag vX.Y.Z
git push origin main && git push origin vX.Y.Z
```

[.github/workflows/release.yml](.github/workflows/release.yml) reacts to `v*.*.*` tags, syncs `app/package.json` from the tag (defense in depth — both the local bump and CI sync end up at the same version), and runs `electron-builder --publish always`.

### Multi-OS jobs must be serialized

The release workflow's `macos` job uses `needs: windows`. **Don't parallelize it.** Concurrent `electron-builder --publish always` calls race the GitHub Releases API — the second job's "create release" overwrites the first job's assets, leaving the release with only one OS's files. See memory `electron-builder-publish-race` for full context and recovery procedure.

If you add a Linux job, chain it with `needs: macos`.

## Repo conventions

- **Vietnamese in user-facing strings.** UI labels, toast messages, error messages, README sections — everything user-facing is in Vietnamese. Code, comments, and commit messages are in English.
- **No UI framework in the renderer.** Don't introduce React/Vue/Svelte — see the README "Đóng góp" section. Vanilla TS + CSS modules.
- **`@shared` alias** in the Vite config maps to [app/src/shared/](app/src/shared/) for the renderer. Main process uses relative imports.
- **Strict TS everywhere.** Both `tsconfig.main.json` (CommonJS for Electron main) and `tsconfig.json` (ESNext for renderer) have `strict: true`.
- The constants file [app/src/shared/constants.ts](app/src/shared/constants.ts) is the source of truth for codec preferences, quality presets, channel names, signal server URL, and adaptive-quality thresholds. The web viewer has its own copy in [web-viewer/src/constants.ts](web-viewer/src/constants.ts) — keep them in sync when changing channel names.
