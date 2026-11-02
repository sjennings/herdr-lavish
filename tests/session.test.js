import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  keyFromUrl,
  sessionFromChromeHtml,
  normalizeChat,
  applyChatSync,
  queuedPrompt,
  sendBody,
} from "../mods/lavish/session.js";

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chrome.html"), "utf8");

test("keyFromUrl takes the session key from a session URL", () => {
  assert.equal(keyFromUrl("http://127.0.0.1:4711/session/abc123def4567890"), "abc123def4567890");
  assert.equal(keyFromUrl("http://127.0.0.1:4711/session/abc123def4567890?no-gate=1"), "abc123def4567890");
  assert.equal(keyFromUrl("http://127.0.0.1:4711/session/"), "");
  assert.equal(keyFromUrl("not a url"), "");
});

test("sessionFromChromeHtml reads the state the browser bootstraps from", () => {
  const session = sessionFromChromeHtml(fixture);
  assert.equal(session.key, "abc123def4567890");
  assert.equal(session.file, "/tmp/proj/.lavish/plan.html");
  assert.equal(session.ended, false);
  assert.equal(session.revision, 3);
  assert.equal(session.chat.length, 3);
  assert.equal(session.chat[0].role, "user");
  assert.equal(session.chat[0].kind, "message");
  assert.equal(session.chat[1].role, "agent");
  assert.equal(session.chat[2].kind, "annotation");
  assert.equal(session.chat[2].anchor.quote, "Starter $9/mo");
});

test("sessionFromChromeHtml refuses pages without embedded state", () => {
  assert.throws(() => sessionFromChromeHtml("<html><body>404</body></html>"), /#lavish-session/);
  assert.throws(() => sessionFromChromeHtml('<script id="lavish-session" type="application/json">{</script>'), /JSON/);
});

test("normalizeChat keeps the server's kinds and drops noise", () => {
  const chat = normalizeChat([
    null,
    { role: "agent", text: "hi", html: "<p>hi</p>", at: "t1" },
    { role: "user", kind: "whiteboard", text: "w", at: "t2" },
    { role: "user", kind: "unknown-kind", text: "u", at: "t3" },
    { role: "user", text: "plain", at: "t4", attachments: [{ id: "a1", name: "x.png" }] },
  ]);
  assert.deepEqual(chat, [
    { role: "agent", text: "hi", at: "t1" },
    { role: "user", kind: "whiteboard", text: "w", at: "t2" },
    { role: "user", kind: "message", text: "u", at: "t3" },
    { role: "user", kind: "message", text: "plain", at: "t4", attachments: [{ id: "a1", name: "x.png" }] },
  ]);
});

test("applyChatSync takes newer revisions and ignores older or equal ones", () => {
  const base = { chat: [], revision: 3 };
  const same = applyChatSync(base, { chat: [{ role: "agent", text: "x", at: "t" }], chat_revision: 3 });
  assert.equal(same, base, "equal revision is ignored");
  const older = applyChatSync(base, { chat: [], chat_revision: 2 });
  assert.equal(older, base, "older revision is ignored");
  const newer = applyChatSync(base, { chat: [{ role: "agent", text: "x", at: "t" }], chat_revision: 4 });
  assert.equal(newer.revision, 4);
  assert.equal(newer.chat.length, 1);
});

test("sendBody builds the body the browser chrome sends", () => {
  assert.deepEqual(sendBody(["fix the chart", "  "]), {
    prompts: [queuedPrompt("fix the chart")],
    domSnapshot: "",
  });
  assert.deepEqual(sendBody(["done"], { end: true }), {
    prompts: [queuedPrompt("done")],
    domSnapshot: "",
    endSession: true,
  });
  assert.deepEqual(queuedPrompt("note"), {
    uid: "",
    prompt: "note",
    selector: "",
    tag: "message",
    text: "Freeform message",
  });
});
