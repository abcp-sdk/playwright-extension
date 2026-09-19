# playwright-extension

A standalone abc-protocol **extension server** exposing browser-automation
tools (Playwright core) over NATS. It drives a **remote** Chromium over CDP
(e.g. a `selenium/standalone-chrome` node or a headless Chrome with
`--remote-debugging-port`), so the extension image bundles no browser.

## Design

- **Own process, own repo.** The agent discovers it over `abc.discover` plus an
  `abc-presence` heartbeat; no agent/easylab code change is required.
- **One context key.** `browser_create_context` opens an isolated
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

Official `playwright-mcp` core tool names, each with a required `context_id`:

`browser_navigate`, `browser_navigate_back`, `browser_snapshot`,
`browser_click`, `browser_type`, `browser_hover`, `browser_select_option`,
`browser_take_screenshot`, `browser_wait_for`, `browser_press_key`,
`browser_evaluate`, `browser_resize`, `browser_tabs`,
`browser_console_messages`, `browser_network_requests`,
`browser_network_request`, `browser_handle_dialog`, `browser_drag`,
`browser_find`, `browser_run_code_unsafe`, `browser_fill_form`,
`browser_emulate_media`, `browser_file_upload`, plus
`browser_create_context`.

`target` arguments accept either a snapshot `ref` (e.g. `e12`, resolved via
Playwright's `aria-ref` engine against the last AI snapshot from
`browser_snapshot`) or a normal Playwright selector.

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
