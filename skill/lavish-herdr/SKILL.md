---
name: lavish-herdr
description: Open a lavish-axi HTML artifact review session inside the Herdr app instead of the browser. Use when the user asks to open, review or send feedback on a Lavish artifact "in herdr", "in a herdr pane", or when the user wants the review surface beside the agent terminal.
allowed-tools: Bash(lavish-herdr:*), Bash(lavish-axi:*)
---

# Lavish in Herdr

`lavish-herdr` takes the same arguments as `lavish-axi` and prints the same
output. The only difference: the session opens as a pane beside your terminal
in the Herdr app, not in a browser tab.

| The user wants | Run |
| --- | --- |
| Review an artifact in herdr | `lavish-herdr <file.html>` (same flags as `lavish-axi`) |
| Wait for the pane's feedback | `lavish-axi poll <file.html>` — unchanged |
| Reply on the board | `lavish-axi reply <file.html> --agent-reply "..."` — unchanged |
| End the session | `lavish-axi end <file.html>` — unchanged |

The command exits as soon as the session is open. The pane is the browser
chrome drawn natively: the conversation with the agent's replies, a feedback
composer (queue messages, then **Send** or **Send & End**), and **End**.
Feedback queued in the pane reaches your running `lavish-axi poll` exactly
like browser feedback, so keep polling as the lavish-axi skill says.

The pane cannot draw the artifact itself (Herdr has no web view) and cannot
annotate elements or selected text: the pane's **Open in browser** opens the
same session for those, for attachments, whiteboard editing, export and
share. The session is the same; nothing is lost.

If Herdr is not running, the command opens the browser instead and says so on
stderr. `LAVISH_HERDR_PLACE=down|tab` changes where the pane opens.
