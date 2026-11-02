# herdr-lavish design

A native herdr-app mod that replaces the Lavish Editor **chrome** — the
review surface around the artifact — not the artifact itself. lavish-axi
still runs its own local server and CLI untouched. Instead of a browser
tab the session opens a herdr pane, and that pane talks to the same HTTP
and WebSocket API the browser page uses.

## What "compatible" means

herdr-app has no web view, and a Lavish artifact is arbitrary HTML with
its own design system. So the pane cannot draw the artifact, and this
project does not try. Compatibility means **the wire, not the pixels**:

1. The server receives the same requests the browser chrome sends:
   bootstrap `GET /session/:key`, live events `WS /events/:key`,
   feedback `POST /api/:key/prompts`, and end `POST /api/:key/end`, with
   the same prompt shape the chrome sends (`{uid, prompt, selector, tag,
   text}` and `endSession`).
2. The agent CLI is untouched. `lavish-axi poll/reply/end` keep running
   as usual; feedback queued in the pane is delivered to the running
   poll exactly like browser feedback, byte-for-byte the same store path
   (`queuePrompts` → `takeFeedback`).
3. Everything the pane cannot draw is one click away: the header's
   **Open in browser** opens the same session URL in the system browser
   (`cx.open_url`). The session is the same; nothing is lost.

## Pieces

```
bin/lavish-herdr          launcher + passthrough (one script, two modes)
mods/lavish/              the herdr mod (installed as mods/lavish)
  main.js                 View: state machine, header, conversation, composer, queue
  api.js                  HTTP + WebSocket client for one Lavish session
  session.js              pure model: parse the chrome page state, normalize chat,
                          build the request bodies the browser chrome sends
skill/lavish-herdr/       the agent skill install.sh links into ~/.claude/skills
tests/                    node --test model/launcher/install tests, pane-e2e.sh
```

### Launcher (`bin/lavish-herdr`)

- `lavish-herdr <file.html> [flags]`: pane mode. Runs `lavish-axi <file>
  [flags] --no-open`, reads the session URL from its stdout, opens the
  pane, then relays lavish-axi's stdout verbatim and exits with its exit
  code, so the agent contract (JSON output, next_step text) is identical.
  lavish-axi has no `PLANNOTATOR_BROWSER`-style override: its browser
  open is the npm `open` package, suppressed only by `--no-open` or
  `LAVISH_AXI_NO_OPEN=1`. That flag **is** the wiring point.
- Pane mode triggers only when the first non-flag argument is an existing
  `.html`/`.htm` file. Everything else — `poll`, `reply`, `end`,
  `export`, `share`, `stop`, `playbook`, `design`, `--help` — is passed
  through with `exec lavish-axi "$@"`, untouched.
- The pane splits right of the terminal that started the session
  (`$HC_TERMINAL_ID` in `herdr-app ls`), else opens a tab.
  `LAVISH_HERDR_PLACE=down|tab` changes that. With no herdr window the
  launcher opens the session URL with the system opener and says so on
  stderr; the session stays the same.

### Session load and live state (`api.js`, `session.js`)

`props().url` is the session URL; its last path segment is the session
key. Bootstrap is the page the browser loads: `GET /session/:key` serves
the chrome HTML with the server-owned state embedded in
`<script id="lavish-session" type="application/json">…</script>`. The
mod parses that (same data the chrome bootstraps from): session key,
file, `initialEnded`, `initialChat`, `initialChatRevision`.

Live updates use the same WebSocket the chrome uses, `WS /events/:key`:
messages `{type, data}` of `chat-sync`, `agent-reply`, `agent-presence`,
`layout-warnings`, `ended`, `reload`. The server's same-origin guard
requires a matching `Origin` on the upgrade and on every write, so every
request the mod sends carries `Origin: <session origin>`. If the socket
cannot connect or drops, the mod falls back to re-fetching the session
page every 2.5 s and diffing `chat_revision`, so the pane degrades to
slower updates, never to a dead UI.

One consequence of not holding the browser's WebSocket: the server only
schedules its `browser_disconnected` poll result when a **connected**
review window leaves. A pane-only session never schedules it. But if the
user opens the browser from the pane and later closes it, the poll can
still report `browser_disconnected` while the pane keeps working; the
agent will ask whether to reopen. That is the server's designed
semantics, documented in the README.

Session state is one state machine, never loose booleans:

```
loading -> ready -> sending -> sent{queued|ended}
             \-> error{message}       sending -> ready (failure, toast)
ready + ended (event, initialEnded, or 409) -> ended
```

`ended` is read-only: the composer hides, the header keeps **Open in
browser** only. After `Send & End` the pane shows the result and closes
itself after 2 s (`run("pane.close")` on the pane id from `panes()`).

### Conversation, queue, decisions (`main.js`)

Chat entries are the server's own shapes, normalized for display only:
user entries `{role:"user", kind: message|annotation|whiteboard|
layout-warnings, text, at, anchor?, attachments?}`, agent entries
`{role:"agent", text, at}`. Annotations made in the browser (kind
`annotation`, with an anchor quote) render in the pane as quoted text so
the pane shows the full conversation even when feedback was partly given
in the browser.

The composer queues freeform messages — the pane's native feedback
path, the same `{tag:"message", text:"Freeform message"}` prompt the
chrome's conversation panel sends. Queued items are a local list: edit,
remove, then **Send** (`POST /api/:key/prompts`, session stays open for
more rounds) or **Send & End** (same body with `endSession: true`).
**End** without feedback is `POST /api/:key/end`. On a `409 ended`
response the pane adopts the ended state instead of showing an error.

Element/text **annotation** needs the artifact DOM, so it stays in the
browser: the composer's hint says so, and **Open in browser** is always
one click. Attachments, whiteboard editing, layout-warnings triage,
export and share are browser-only too; each is listed in the README so
nobody thinks it is silently missing.

Agent presence (`agent-presence` events; Working while a poll waits)
colors the header dot when the socket is live; the polling fallback
shows no presence.

## Out of scope (open in browser instead)

The artifact itself (any HTML), element and text annotation, image
attachments, Mermaid whiteboard editing, layout-warnings triage, export
and share dialogs, session history. The header shows **Open in browser**
in every state.

## Testing

- `node --test tests/` — the pure model against a trimmed chrome-page
  fixture, the launcher with stubbed `lavish-axi`/`herdr-app`/`jq`/opener
  binaries, and install.sh against a temp `HOME`/`HERDR_APP_HOME`.
- `herdr-app check mods/lavish` after every mod change (it sandboxes
  `fetch`, so it proves load + first render only).
- `tests/pane-e2e.sh` — a real session on a real lavish-axi server,
  driven through a pane the script opens itself (its own herdr space) via
  the dev-only `props().steps` replay, asserted through a state dump the
  mod writes with `writeTextFile`, closed by the same script. Never run
  against the person's spaces.
- Wire parity: the e2e also posts the same feedback the pane sends via
  `curl` and confirms the pane's request body is accepted identically.

## Dev loop

```sh
node --test tests/               # model, launcher, install
herdr-app check mods/lavish      # after every mod change
tests/pane-e2e.sh                # live, own space; cleans up after itself
```
