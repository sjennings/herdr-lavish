// Pure session model for one Lavish session: parsing the state embedded in
// the chrome page the browser loads, normalizing chat entries for display,
// and building the exact request bodies the browser chrome sends.
//
// No imports: this file also runs under node --test (tests/session.test.js).

/** The session key from a session URL: the last path segment. */
export function keyFromUrl(url) {
  const path = String(url || "").split("?")[0].replace(/\/+$/, "");
  const key = path.split("/").pop() || "";
  return /^[a-f0-9]{6,32}$/.test(key) ? key : "";
}

/** The state the chrome page embeds, from its HTML. Throws when absent. */
export function sessionFromChromeHtml(html) {
  const text = String(html || "");
  const at = text.indexOf('<script id="lavish-session" type="application/json">');
  if (at < 0) throw new Error("no #lavish-session state in the session page");
  const start = at + '<script id="lavish-session" type="application/json">'.length;
  const end = text.indexOf("</script>", start);
  if (end < 0) throw new Error("unterminated #lavish-session state");
  let state;
  try {
    state = JSON.parse(text.slice(start, end));
  } catch {
    throw new Error("#lavish-session state is not valid JSON");
  }
  if (!state || !state.key) throw new Error("#lavish-session state has no session key");
  return {
    key: String(state.key),
    file: String(state.file || ""),
    ended: state.initialEnded === true,
    endedBy: state.initialEndedBy || null,
    chat: normalizeChat(state.initialChat),
    revision: numberOr(state.initialChatRevision, 0),
  };
}

/** Chat entries in the server's own shapes, display-normalized.
 *  user:   {role:"user", kind, text, at, anchor?, attachments?}
 *  agent:  {role:"agent", text, at} */
export function normalizeChat(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const text = String(item.text || "");
    if (item.role === "agent") {
      out.push({ role: "agent", text, at: String(item.at || "") });
      continue;
    }
    const kind = ["message", "annotation", "whiteboard", "layout-warnings"].includes(item.kind)
      ? item.kind
      : "message";
    const entry = { role: "user", kind, text, at: String(item.at || "") };
    if (item.anchor && typeof item.anchor === "object") entry.anchor = item.anchor;
    if (Array.isArray(item.attachments) && item.attachments.length) entry.attachments = item.attachments;
    out.push(entry);
  }
  return out;
}

/** A chat-sync payload ({chat, ack_ids?, chat_revision}) applied onto state.
 *  Older revisions are ignored, so reconnects and polls never rewind chat. */
export function applyChatSync(state, sync) {
  if (!sync || typeof sync !== "object") return state;
  const revision = numberOr(sync.chat_revision, 0);
  if (revision <= state.revision) return state;
  return { ...state, chat: normalizeChat(sync.chat), revision };
}

/** One queued freeform prompt: the shape the chrome's conversation panel
 *  sends for a typed message (tag "message"; `text` is the panel's label). */
export function queuedPrompt(text) {
  return { uid: "", prompt: String(text || ""), selector: "", tag: "message", text: "Freeform message" };
}

/** The POST /api/:key/prompts body for a queue of texts. */
export function sendBody(texts, { end = false } = {}) {
  const prompts = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .map(queuedPrompt);
  const body = { prompts, domSnapshot: "" };
  if (end) body.endSession = true;
  return body;
}

function numberOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
