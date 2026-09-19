# playwright-extension

A standalone abc-protocol **extension server** exposing browser-automation
tools (Playwright core) over NATS. It drives a **remote** Chromium over CDP
(e.g. a `selenium/standalone-chrome` node or a headless Chrome with
`--remote-debugging-port`), so the extension image bundles no browser.

## Design

- **Own process, own repo.** The agent discovers it over `abc.discover` plus an
  `abc-presence` heartbeat; no agent/easylab code change is required.
- **One context key.** `browser-create-context` opens an isolated
  `BrowserContext` on the shared CDP browser and returns a `context_id` (UUID).
  Every other tool takes that `context_id`; the key is bound to the calling
  `(tenant, session)` so it cannot be used elsewhere.
- **Idle reaping.** Contexts unused for `PLAYWRIGHT_IDLE_TIMEOUT_MS` are closed;
  a session deleting (`lifecycle: deleted`) closes all of its contexts; a
  `PLAYWRIGHT_MAX_CONTEXTS` cap LRU-evicts an idle context.
- **Screenshots are `file:<code>`.** Image bytes go through the agent's
  `abc.<tenant>.file.ingest` RPC (the agent owns the blob + metadata backends),
  so the result is the same durable `file:<code>` reference that in-process
  image generation returns — regardless of the agent's blob backend (NATS
  object store or S3). No S3 credentials are needed here.

## Tools

kebab-case names, curated from the official `playwright-mcp` surface down to
the **28** tools that are either commonly used or cannot be expressed as plain
`page.*` calls. Each takes a required `context_id` (except
`browser-create-context`, and `browser-close-context` with `all: true`).

**Session**
`browser-create-context`, `browser-close-context` (one, or `all: true`)

**Navigation / inspection**
`browser-navigate`, `browser-navigate-back`, `browser-snapshot`, `browser-find`

**Interaction**
`browser-click`, `browser-type`, `browser-hover`, `browser-select-option`,
`browser-press-key`, `browser-wait-for`, `browser-resize`, `browser-tabs`,
`browser-drag`, `browser-fill-form`, `browser-handle-dialog`,
`browser-evaluate`

**Observability** (historical; not expressible via `page.*`)
`browser-console-messages`, `browser-network-requests`,
`browser-network-request`

**Files** (bytes routed through the agent, returned as `file:<code>`)
`browser-take-screenshot`, `browser-pdf-save`, `browser-file-upload`,
`browser-drop`, `browser-storage-state`, `browser-set-storage-state`

**Escape hatch**
`browser-run-code-unsafe` — runs a Playwright snippet with `page`. Use it for
anything not covered above: mouse coordinates, network routes
(`page.route`/`context.setOffline`), cookies/localStorage/sessionStorage,
`page.emulateMedia`, and assertions.

Deliberately **not** tools (Thin `page.*` wrappers, better done via
`browser-run-code-unsafe`): mouse-coordinate tools, `verify-*`/`generate-locator`,
per-kind cookie/local/sessionstorage tools, `route*`/`network-state-set`,
`emulate-media`, `get-config`. Also not tools: the Playwright Dashboard /
recorder / debugger family (annotate, highlight, resume, recording, tracing,
video) — unsupported over a bare remote CDP target.

`target` arguments accept either a snapshot `ref` (e.g. `e12`, resolved via
Playwright's `aria-ref` engine against the last AI snapshot from
`browser-snapshot`) or a normal Playwright selector.

## Configuration (environment)

| Env | Default | Meaning |
|---|---|---|
| `NATS_URL` | `nats://127.0.0.1:4222` | abc bus to serve over |
| `PLAYWRIGHT_SELENIUM_URL` | — | Selenium WebDriver base URL (e.g. `http://selenium:4444`) |
| `PLAYWRIGHT_CDP_ENDPOINT` | — | Raw CDP endpoint (used when `PLAYWRIGHT_SELENIUM_URL` is unset) |
| `PLAYWRIGHT_BROWSER` | `chrome` | WebDriver browser name |
| `PLAYWRIGHT_VIEWPORT` | (browser default) | e.g. `1280x720` |
| `PLAYWRIGHT_IGNORE_HTTPS_ERRORS` | `true` | ignore TLS errors |
| `PLAYWRIGHT_IDLE_TIMEOUT_MS` | `600000` | close idle contexts (0 disables) |
| `PLAYWRIGHT_MAX_CONTEXTS` | `8` | live context cap (LRU-evict) |
| `PLAYWRIGHT_ACTION_TIMEOUT_MS` | `30000` | default action timeout |

One of `PLAYWRIGHT_SELENIUM_URL` / `PLAYWRIGHT_CDP_ENDPOINT` is required. For
Selenium, each context creates a WebDriver session and attaches over the
session's `se:cdp` capability; closing the context deletes the session.

## Build

```bash
./build-image.sh              # buildkitd -> forgejo OCI
```

## Serve

```bash
NATS_URL=nats://nats:4222 \
PLAYWRIGHT_SELENIUM_URL=http://selenium:4444 \
node dist/main.js
```
