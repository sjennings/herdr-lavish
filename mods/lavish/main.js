// The Lavish review pane: the browser chrome's conversation, feedback
// queue and session decisions, drawn natively over the same server API.
// The artifact itself stays in the browser (herdr-app has no web view):
// the header's Open in browser opens the same session URL.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { props, run, theme, home, writeTextFile, readTextFile } from "herdr";
import { Api } from "./api.js";
import { applyChatSync, keyFromUrl, sendBody } from "./session.js";

const CLOSE_AFTER_MS = 2000;
const POLL_FALLBACK_MS = 2500;
const STEP_MS = 400;

const KIND_LABELS = {
  message: "Message",
  annotation: "Annotation",
  whiteboard: "Whiteboard",
  "layout-warnings": "Layout fixes",
};

export default class Lavish extends View {
  init(_props, cx) {
    this.state = { name: "loading" };
    this.toast = null;
    this.queue = []; // [{text}]
    this.editing = null; // queue index being edited
    this.editInput = TextareaState.new();
    this.composer = TextareaState.new({ placeholder: "Feedback for the agent… (annotate elements in the browser)" });
    this.working = null; // null unknown, true working, false listening/waiting
    this.events = null; // live socket handle
    this.pollTimer = null;
    this.closed = false;
    this.ownPane = null;

    const url = props()?.url;
    if (!keyFromUrl(url)) {
      this.state = { name: "error", message: "No valid session URL. Open this pane through lavish-herdr." };
      return;
    }
    this.api = new Api(url);
    cx.spawn(async (cx) => {
      try {
        this.session = await this.api.load();
        this.state = this.session.ended ? { name: "ended", by: this.session.endedBy } : { name: "ready" };
        this.connectLive(cx);
        await this.replaySteps(cx);
      } catch (e) {
        this.state = { name: "error", message: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  close(_cx) {
    this.closed = true;
    this.events?.close();
    this.pollTimer?.cancel?.();
  }

  // --- live state ---------------------------------------------------------

  connectLive(cx) {
    this.events = this.api.connectEvents(
      (event) => this.onEvent(event, cx),
      () => this.startPolling(cx),
    );
  }

  onEvent({ type, data }, cx) {
    if (this.closed) return;
    if (type === "chat-sync") {
      this.session = applyChatSync(this.session, data);
      this.dump();
    } else if (type === "agent-presence") {
      this.working = data?.state === "working" ? true : data?.state ? false : null;
    } else if (type === "agent-reply") {
      this.working = false; // chat-sync follows with the entry itself
    } else if (type === "ended") {
      this.markEnded(data?.ended_by);
      this.events?.close();
    } else if (type === "reload") {
      cx.spawn(async (cx) => {
        try {
          const fresh = await this.api.load();
          this.session = fresh.revision > this.session.revision ? fresh : this.session;
          this.markEndedIf(fresh.ended, fresh.endedBy);
        } catch {}
        cx.notify();
      });
      return;
    }
    cx.notify();
  }

  markEndedIf(ended, by) {
    if (ended && this.state.name !== "sent") this.markEnded(by);
  }

  markEnded(by) {
    if (this.state.name === "sent" || this.state.name === "ended") return;
    this.state = { name: "ended", by: by || "user" };
  }

  /** The socket is gone (or never came up): re-fetch the session page. */
  startPolling(cx) {
    if (this.pollTimer || this.closed) return;
    this.working = null;
    this.pollTimer = cx.timer.every(POLL_FALLBACK_MS, (cx) => {
      if (this.closed || this.state.name === "ended" || this.state.name === "sent") return;
      cx.spawn(async (cx) => {
        try {
          const fresh = await this.api.load();
          if (fresh.revision > this.session.revision) this.session = fresh;
          this.markEndedIf(fresh.ended, fresh.endedBy);
          this.dump();
        } catch {}
        cx.notify();
      });
    });
  }

  // --- queue and decisions ------------------------------------------------

  queueText(cx) {
    const text = this.composer.value().trim();
    if (!text || this.state.name !== "ready") return;
    this.queue.push({ text });
    this.composer.set_value("");
    cx.notify();
  }

  removeQueued(i, cx) {
    this.queue.splice(i, 1);
    if (this.editing === i) this.editing = null;
    else if (this.editing != null && this.editing > i) this.editing--;
    cx.notify();
  }

  startEdit(i, cx) {
    this.editing = i;
    this.editInput.set_value(this.queue[i].text);
    cx.notify();
  }

  saveEdit(cx) {
    if (this.editing == null) return;
    const text = this.editInput.value().trim();
    if (text) this.queue[this.editing] = { text };
    this.editing = null;
    cx.notify();
  }

  /** Send the queue (end=false) or send and end the session (end=true). */
  send(end, cx) {
    if (this.state.name !== "ready" || !this.queue.length) return;
    this.ownPane = props()?.pane ?? null;
    this.state = { name: "sending" };
    this.toast = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const body = sendBody(this.queue.map((item) => item.text), { end });
      const res = await this.api.sendFeedback(body).catch(failedRequest);
      await this.dump();
      if (res.status === 409) {
        this.markEnded(res.json?.ended_by);
        cx.notify();
        return;
      }
      if (!res.ok) {
        this.state = { name: "ready" };
        this.toast = `Could not send: ${res.json?.error ?? `HTTP ${res.status}`}`;
        cx.notify();
        return;
      }
      if (res.json && Array.isArray(res.json.chat)) this.session = applyChatSync(this.session, res.json);
      this.queue = [];
      if (end) {
        this.state = { name: "sent", outcome: "ended" };
        this.events?.close();
        cx.timer.after(CLOSE_AFTER_MS, () => this.closePane());
      } else {
        this.state = { name: "ready" };
        this.toast = "Feedback sent to the agent.";
      }
      await this.dump();
      cx.notify();
    });
  }

  end(cx) {
    if (this.state.name !== "ready") return;
    this.ownPane = props()?.pane ?? null;
    this.state = { name: "sending" };
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await this.api.end().catch(failedRequest);
      await this.dump();
      if (res.status === 409) this.markEnded(res.json?.ended_by);
      else if (!res.ok) {
        this.state = { name: "ready" };
        this.toast = `Could not end: ${res.json?.error ?? `HTTP ${res.status}`}`;
      } else {
        this.state = { name: "sent", outcome: "ended" };
        this.events?.close();
        cx.timer.after(CLOSE_AFTER_MS, () => this.closePane());
      }
      cx.notify();
    });
  }

  closePane() {
    if (this.ownPane) run("pane.close", { pane: this.ownPane });
  }

  // --- dev/test replay (props().steps) and state dump (props().dump) ------

  async replaySteps(cx) {
    const steps = props()?.steps;
    if (!Array.isArray(steps) || !steps.length) return;
    for (const step of steps) {
      await cx.sleep(STEP_MS);
      if (this.closed) return;
      const [name, ...args] = step;
      if (name === "queue") this.queue.push({ text: String(args[0] ?? "") });
      else if (name === "remove") this.removeQueued(args[0], cx);
      else if (name === "send") this.send(false, cx);
      else if (name === "sendEnd") this.send(true, cx);
      else if (name === "end") this.end(cx);
      cx.notify();
      await this.dump();
    }
  }

  async dump() {
    const path = props()?.dump;
    if (!path) return;
    const text = JSON.stringify({
      state: this.state,
      key: this.session?.key,
      revision: this.session?.revision,
      chat: this.session?.chat ?? [],
      queue: this.queue,
      toast: this.toast,
    });
    // writeTextFile is compare-and-swap: expected null creates, else it must
    // match. Try our own last write, then whatever is actually there.
    for (const expected of [this.lastDump ?? null, await readTextFile(path).catch(() => null)]) {
      try {
        await writeTextFile(path, text, expected);
        this.lastDump = text;
        return;
      } catch {}
    }
  }

  // --- rendering ----------------------------------------------------------

  button(t, id, label, onClick, { disabled = false, danger = false, primary = false } = {}) {
    const tone = primary
      ? { bg: t.solid, fg: t.solid_foreground, border: t.solid }
      : danger
        ? { bg: t.surface, fg: t.blocked, border: t.blocked }
        : { bg: t.surface, fg: t.foreground, border: t.border };
    return div().id(id).h(28).px(12).flex().items_center().rounded(6).text_size(12.5)
      .border_1().border_color(tone.border).bg(tone.bg).text_color(tone.fg)
      .when(disabled, (el) => el.opacity(0.5))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)));
  }

  header(t) {
    const live = this.state.name === "ready" || this.state.name === "sending";
    const busy = this.state.name === "sending";
    const count = this.queue.length;
    let presence = null;
    if (live && this.working != null) {
      presence = h_flex().id("presence").flex().items_center().gap(5).text_size(11).text_color(t.muted)
        .child(div().w(7).h(7).rounded(4).bg(this.working ? t.accent : t.dim))
        .child(this.working ? "Agent working" : "Agent listening");
    }
    return h_flex().id("lavish-header").flex_none().h(44).px(14).gap(10).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Lavish"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(tildePath(this.session?.file ?? "")))
      .when(!!presence, (el) => el.child(presence))
      .when(!!this.api, (el) =>
        el.child(this.button(t, "open-browser", "Open in browser", (cx) => cx.open_url(this.api.sessionUrl()))))
      .when(live, (el) =>
        el.child(this.button(t, "end-session", "End", (cx) => this.end(cx), { disabled: busy || !!count, danger: true })))
      .when(live && !!count, (el) =>
        el.child(this.button(t, "send", busy ? "Sending…" : `Send · ${count}`, (cx) => this.send(false, cx), { disabled: busy, primary: true }))
          .child(this.button(t, "send-end", "Send & End", (cx) => this.send(true, cx), { disabled: busy })));
  }

  chatBubble(t, entry, i) {
    const agent = entry.role === "agent";
    const label = agent || entry.kind === "message" ? null : (KIND_LABELS[entry.kind] ?? null);
    const quote = !agent && entry.anchor && typeof entry.anchor.quote === "string" ? entry.anchor.quote : null;
    const bubble = v_flex().id(`chat-${i}`).py(6).px(10).rounded(8).gap(4)
      .bg(agent ? t.surface : t.popover)
      .border_1().border_color(t.border);
    if (label) {
      bubble.child(div().text_size(10).font_semibold().text_color(t.dim).child(label.toUpperCase()));
    }
    if (quote) {
      bubble.child(div().text_size(12).italic().text_color(t.muted).child(`“${quote}”`));
    }
    if (entry.text) {
      bubble.child(div().text_size(13).text_color(t.foreground).child(entry.text));
    }
    const row = h_flex().id(`chat-row-${i}`).w_full().py(2);
    return (agent ? row.justify_start() : row.justify_end()).child(bubble);
  }

  queueRow(t, item, i) {
    const editing = this.editing === i;
    const row = h_flex().id(`queue-${i}`).w_full().gap(6).items_center()
      .child(div().flex_1().min_w(0).rounded(8).border_1()
        .border_color(editing ? t.input : t.border).bg(t.background).px(8).py(6)
        .when(editing, (el) => el
          .on_key_down((ev, cx) => {
            if (ev.keystroke === "cmd-enter" || ev.keystroke === "ctrl-enter") this.saveEdit(cx);
            if (ev.key === "escape") { this.editing = null; cx.notify(); }
          })
          .child(Textarea.new(this.editInput).text_size(13).text_color(t.foreground)))
        .when(!editing, (el) => el
          .cursor_pointer()
          .on_click((_e, cx) => this.startEdit(i, cx))
          .child(div().text_size(13).text_color(t.foreground).child(item.text))))
      .child(this.button(t, `queue-remove-${i}`, "✕", (cx) => this.removeQueued(i, cx), { danger: true }));
    const wrap = v_flex().gap(4).child(row);
    if (editing) {
      wrap.child(h_flex().justify_end().gap(6)
        .child(this.button(t, `queue-cancel-${i}`, "Cancel", (cx) => { this.editing = null; cx.notify(); }))
        .child(this.button(t, `queue-save-${i}`, "Save", (cx) => this.saveEdit(cx), { primary: true })));
    }
    return wrap;
  }

  composerEl(t) {
    return v_flex().id("lavish-composer").flex_none().p(12).gap(8).border_t(1).border_color(t.border)
      .on_key_down((ev, cx) => {
        if (ev.keystroke === "cmd-enter" || ev.keystroke === "ctrl-enter") this.queueText(cx);
      })
      .child(div().rounded(8).border_1().border_color(t.input).bg(t.background).px(10).py(8)
        .child(Textarea.new(this.composer).text_size(13).text_color(t.foreground)))
      .child(h_flex().justify_end().gap(8).items_center()
        .child(div().text_size(11).text_color(t.dim).flex_1().child("Ctrl+Enter queues · annotate elements in the browser"))
        .child(this.button(t, "queue", "Queue", (cx) => this.queueText(cx), { disabled: !this.composer.value().trim() })));
  }

  centered(t, text, color) {
    return v_flex().flex_1().items_center().justify_center().p(24)
      .child(div().text_size(14).text_color(color ?? t.muted).child(text));
  }

  body(t, cx) {
    switch (this.state.name) {
      case "loading":
        return this.centered(t, "Loading session…");
      case "error":
        return this.centered(t, this.state.message, t.blocked);
      case "ended":
        return this.centered(t, "Session ended. Return to your agent.");
      case "sent":
        return this.centered(t, "Feedback sent. Session ended.", t.foreground);
      default: {
        const chat = this.session?.chat ?? [];
        const conversation = v_flex().id("lavish-chat").flex_1().min_h(0).px(14).py(10).gap(2);
        if (!chat.length) {
          conversation.child(div().text_size(12).text_color(t.dim)
            .child("No feedback yet. Queue a message below, or annotate in the browser."));
        }
        for (let i = 0; i < chat.length; i++) conversation.child(this.chatBubble(t, chat[i], i));
        const queue = v_flex().id("lavish-queue").flex_none().px(12).pt(8).gap(6);
        if (this.queue.length) {
          queue.child(div().text_size(11).font_semibold().text_color(t.dim)
            .child(`QUEUED · ${this.queue.length}`));
        }
        for (let i = 0; i < this.queue.length; i++) queue.child(this.queueRow(t, this.queue[i], i));
        return v_flex().flex_1().min_h(0).child(conversation).child(queue).child(this.composerEl(t));
      }
    }
  }

  render(cx) {
    const t = theme();
    return v_flex().id("lavish-root").size_full().bg(t.background).text_color(t.foreground)
      .child(this.header(t))
      .when(!!this.toast, (el) => el.child(div().id("lavish-toast").px(14).py(6).bg(t.surface)
        .border_b(1).border_color(t.border).text_size(12).text_color(t.muted).child(this.toast)))
      .child(v_flex().flex_1().min_h(0).child(this.body(t, cx)));
  }
}

function failedRequest(e) {
  return { status: 0, ok: false, json: { error: String(e?.message ?? e) } };
}

function tildePath(path) {
  const h = home();
  return h && String(path).startsWith(h + "/") ? "~" + String(path).slice(h.length) : String(path || "");
}
