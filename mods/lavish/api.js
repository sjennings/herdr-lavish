// HTTP + WebSocket client for one Lavish session, over the same API the
// browser chrome page uses. The server's same-origin guard requires a
// matching Origin on the WS upgrade and on every write; gpui-kit's fetch
// only refuses client-managed framing headers, so Origin rides along.

import { WebSocket } from "websocket";
import { sessionFromChromeHtml } from "./session.js";

export class Api {
  constructor(url) {
    this.url = String(url || "").split("?")[0];
    this.origin = new URL(this.url).origin;
    this.key = this.url.replace(/\/+$/, "").split("/").pop();
  }

  sessionUrl() {
    return this.url;
  }

  async text(path) {
    const res = await fetch(this.origin + path);
    return { status: res.status, ok: res.ok, text: await res.text() };
  }

  async post(path, body) {
    const res = await fetch(this.origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: this.origin },
      body: JSON.stringify(body ?? {}),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json };
  }

  /** Bootstrap state from the page the browser loads. Throws on a page
   *  that is not a Lavish session (404 HTML, proxy error, ...). */
  async load() {
    const page = await this.text(`/session/${this.key}`);
    if (!page.ok) throw new Error(`session page HTTP ${page.status}`);
    return sessionFromChromeHtml(page.text);
  }

  /** The browser chrome's feedback call. Body from session.js sendBody(). */
  sendFeedback(body) {
    return this.post(`/api/${this.key}/prompts`, body);
  }

  /** The browser chrome's End button. */
  end() {
    return this.post(`/api/${this.key}/end`, {});
  }

  /** Connect the chrome's live-event socket. Resolves with null when the
   *  platform refuses the connection (the caller falls back to polling).
   *  onEvent({type, data}) receives every server event; onDown() fires on
   *  a drop after being up. Returns {close()}. */
  connectEvents(onEvent, onDown) {
    let socket = null;
    let closed = false;
    let downSent = false;
    let reader = null;
    const self = this;
    connect();
    return { close() { closed = true; try { socket?.close(); } catch {} } };

    async function connect() {
      try {
        socket = await WebSocket.connect(`ws://127.0.0.1:${new URL(self.url).port}/events/${self.key}`, {
          headers: { Origin: self.origin },
        });
      } catch {
        if (!closed && !downSent) { downSent = true; onDown(); }
        return;
      }
      downSent = false;
      reader = readLoop();
    }

    async function readLoop() {
      try {
        for (;;) {
          const message = await socket.read();
          if (message == null) break;
          const event = parseEvent(message);
          if (event) onEvent(event);
        }
      } catch {
        // fall through to the drop path
      }
      if (!closed) {
        try { socket.close(); } catch {}
        if (!downSent) { downSent = true; onDown(); }
      }
    }
  }
}

function parseEvent(message) {
  const text = typeof message === "string" ? message : "";
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.type === "string") return { type: parsed.type, data: parsed.data ?? {} };
  } catch {}
  return null;
}
