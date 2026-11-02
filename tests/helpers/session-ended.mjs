// Prints "true" when a Lavish session page reports the session ended.
// Usage: node tests/helpers/session-ended.mjs <page.html>
import { readFileSync } from "node:fs";
import { sessionFromChromeHtml } from "../../mods/lavish/session.js";

try {
  const session = sessionFromChromeHtml(readFileSync(process.argv[2], "utf8"));
  console.log(session.ended ? "true" : "false");
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
