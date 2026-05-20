# Self-audit issues — 2026-05-20

`gh` CLI isn't installed on this host, so issues are tracked here in the repo
and fixed in the same branch. Each entry follows the GitHub-style template
the project would use if/when these get migrated to real Issues.

---

## #1 — Protocol drift: `SystemMessage.action` enum missing `codec` and `peer-bye`

**Severity:** medium
**Files:** [app/src/shared/protocol.ts:171-184](app/src/shared/protocol.ts#L171-L184), [app/src/renderer/lib/connection.ts:1632-1654](app/src/renderer/lib/connection.ts#L1632-L1654), [app/src/renderer/lib/connection.ts:1744-1770](app/src/renderer/lib/connection.ts#L1744-L1770), [app/src/renderer/lib/connection.ts:2202-2207](app/src/renderer/lib/connection.ts#L2202-L2207)

The `SystemMessage.action` union enumerates 13 string literals. The renderer dispatches on `'codec'` (host receives a viewer codec-switch request) and `'peer-bye'` (graceful tear-down marker over the data channel) — both routed through `CHANNEL_SYSTEM` and treated as `SystemMessage` payloads — but neither value is in the union. The literal `{ type: 'system', action: 'peer-bye' }` doesn't even match the `SystemMessage` interface (the `data` field is required). New TS code that imports `SystemMessage` and exhaustively switches on `action` will compile-error or silently miss these branches.

**Fix:** add `'codec'` and `'peer-bye'` to the union; make `data` optional so the bare `peer-bye` message is well-typed.

---

## #2 — `desktopCapturer` sources paired to displays by array index

**Severity:** medium
**File:** [app/src/main/screen-capture.ts:26-35](app/src/main/screen-capture.ts#L26-L35)

`getScreenSources()` does:

```ts
return sources.map((source, index) => {
  const display = displays[index] || primaryDisplay;
  ...
});
```

`desktopCapturer.getSources()` and `screen.getAllDisplays()` have no documented ordering relationship — Chromium enumerates capture sources in OS-driver order, while `screen.getAllDisplays()` orders by Electron's display id. On a multi-monitor setup the index pairing produces wrong `bounds` / `isPrimary` for monitors and the View menu's monitor picker can light up the wrong "active" entry. Each `DesktopCapturerSource` exposes `display_id` (string form of the matching Display id), which is the supported pairing key.

**Fix:** pair on `source.display_id === display.id.toString()`, fall back to primary if not found.

---

## #3 — `showOpenDialog` combines `openFile` + `openDirectory` (broken on Windows)

**Severity:** medium
**File:** [app/src/main/file-transfer.ts:69-89](app/src/main/file-transfer.ts#L69-L89)

```ts
properties: ['openFile', 'openDirectory', 'multiSelections']
```

Per Electron docs, on Windows the OS dialog can only operate in *one* mode at a time — `openFile` and `openDirectory` are mutually exclusive. When both are passed Electron silently keeps `openFile` and drops `openDirectory`, so users can't pick folders via this dialog at all. macOS handles both via `NSOpenPanel`. The repo already supports folder transfer through the drag-drop path (`file:prepareFileOrFolder` zips folders), so the picker only needs to handle files.

**Fix:** drop `openDirectory` from the picker. Folder transfer continues to work through drag-drop.

---

## #4 — English `Monitor N` label leaks into Vietnamese UI

**Severity:** low
**File:** [app/src/main/screen-capture.ts:30](app/src/main/screen-capture.ts#L30)

```ts
name: source.name || `Monitor ${index + 1}`,
```

CLAUDE.md mandates Vietnamese for user-facing strings. The fallback fires on Linux X11 setups where `desktopCapturer` returns sources with empty `name`. The label propagates to the View menu's monitor picker, breaking language consistency.

**Fix:** `Màn hình ${index + 1}`.

---

## Out of scope

- `APP_VERSION = '1.0.0'` in [app/src/shared/constants.ts:4](app/src/shared/constants.ts#L4) is stale (real version is 2.4.0 from `app/package.json`) but unused — not worth touching without removing it entirely.
- `RECONNECT_DELAY` / `MAX_RECONNECT_ATTEMPTS` exports in [app/src/shared/constants.ts:175-176](app/src/shared/constants.ts#L175-L176) are unused; removing them is dead-code cleanup, not a bug.
- Web-viewer `protocol.ts` is intentionally a subset; the missing `FileMessage` / `AnnotationMessage` shapes are by design (web viewer doesn't transfer files or annotate).
