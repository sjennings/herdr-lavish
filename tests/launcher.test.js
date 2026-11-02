import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "lavish-herdr");
const hasJq = spawnSync("jq", ["--version"]).status === 0;

function makeStubs({ lavishFails = false, herdrRunning = true, yamlOutput = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lavish-herdr-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls");
  mkdirSync(calls);

  writeFileSync(join(bin, "lavish-axi"), `#!/bin/sh
echo "argv: $*" >> '${calls}/lavish-axi'
${lavishFails ? "echo '{\"session\":{\"file\":\"x\",\"url\":\"http://127.0.0.1:4711/session/abc123def4567890\",\"status\":\"opened\"}}'; exit 3" :
    yamlOutput ? "printf 'session:\\n  file: x\\n  url: \"http://127.0.0.1:4711/session/abc123def4567890\"\\n  status: opened\\nnext_step: poll now\\n'" :
      'echo \'{"session":{"file":"x","url":"http://127.0.0.1:4711/session/abc123def4567890","status":"opened"},"next_step":"poll now"}\''}
`);
  writeFileSync(join(bin, "herdr-app"), `#!/bin/sh
echo "herdr-app $*" >> '${calls}/herdr-app'
case "$1" in
  status) ${herdrRunning ? "exit 0" : "exit 1"} ;;
  ls) echo '{"spaces":[{"id":"s1","machine":null,"tabs":[{"terminals":[{"terminal":"T9","pane":"p7"}]}]}]}' ;;
  do) echo '{"pane":"pNew"}' ;;
  check) exit 0 ;;
esac
`);
  writeFileSync(join(bin, "open"), `#!/bin/sh
echo "open $*" >> '${calls}/open'
`);
  for (const f of [join(bin, "lavish-axi"), join(bin, "herdr-app"), join(bin, "open")]) {
    execFileSync("chmod", ["+x", f]);
  }
  const artifact = join(dir, "plan.html");
  writeFileSync(artifact, "<html><body>plan</body></html>");
  return { dir, bin, calls, artifact };
}

function run(bin, args, env = {}) {
  return spawnSync(launcher, args, {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HC_TERMINAL_ID: "T9",
      TMPDIR: tmpdir(),
      ...env,
    },
  });
}

function lines(calls, name) {
  return existsSync(join(calls, name)) ? readFileSync(join(calls, name), "utf8").trim().split("\n") : [];
}

const tempDirs = [];
const makeStubsWrapped = (opts) => {
  const stubs = makeStubs(opts);
  tempDirs.push(stubs.dir);
  return stubs;
};
test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("subcommands pass through to lavish-axi untouched", () => {
  const { bin, calls } = makeStubsWrapped();
  const res = run(bin, ["poll", "some.html", "--owner", "x"]);
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.deepEqual(lines(calls, "lavish-axi"), ["argv: poll some.html --owner x"]);
  assert.match(res.stdout.toString(), /poll now/);
  assert.equal(existsSync(join(calls, "herdr-app")), false, "no herdr-app calls in passthrough");
});

test("non-html and missing files pass through", () => {
  const { bin, calls } = makeStubsWrapped();
  run(bin, ["stop"]);
  run(bin, ["--help"]);
  run(bin, ["missing.html"]);
  assert.deepEqual(lines(calls, "lavish-axi"), ["argv: stop", "argv: --help", "argv: missing.html"]);
});

test("pane mode opens the pane and relays output and exit code", { skip: !hasJq && "needs jq" }, () => {
  const { bin, calls, artifact } = makeStubsWrapped();
  const res = run(bin, [artifact, "--reopen"]);
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.deepEqual(lines(calls, "lavish-axi"), [`argv: ${artifact} --reopen --no-open`]);
  assert.match(res.stdout.toString(), /poll now/, "CLI stdout is relayed verbatim");
  const doCalls = lines(calls, "herdr-app").filter((l) => l.includes("pane.split"));
  assert.equal(doCalls.length, 1);
  assert.match(doCalls[0], /--direction right --pane p7 --mod lavish/);
  assert.match(doCalls[0], /"url":"http:\/\/127.0.0.1:4711\/session\/abc123def4567890"/);
  assert.equal(lines(calls, "open").length, 0, "no browser opener");
});

test("pane mode relays a nonzero exit code", { skip: !hasJq && "needs jq" }, () => {
  const { bin, artifact } = makeStubsWrapped({ lavishFails: true });
  const res = run(bin, [artifact]);
  assert.equal(res.status, 3);
});

test("no herdr window: browser fallback with the session URL", () => {
  const { bin, calls, artifact } = makeStubsWrapped({ herdrRunning: false });
  const res = run(bin, [artifact]);
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.match(res.stderr.toString(), /no herdr window/);
  assert.deepEqual(lines(calls, "open"), ["open http://127.0.0.1:4711/session/abc123def4567890"]);
  assert.match(res.stdout.toString(), /poll now/);
});

test("human (YAML-style) lavish-axi output still yields the pane", { skip: !hasJq && "needs jq" }, () => {
  const { bin, calls, artifact } = makeStubsWrapped({ yamlOutput: true });
  const res = run(bin, [artifact]);
  assert.equal(res.status, 0, res.stderr?.toString());
  const split = lines(calls, "herdr-app").filter((l) => l.includes("pane.split"));
  assert.equal(split.length, 1);
  assert.match(split[0], /"url":"http:\/\/127.0.0.1:4711\/session\/abc123def4567890"/);
  assert.match(res.stdout.toString(), /poll now/, "CLI stdout is relayed verbatim");
});

test("LAVISH_HERDR_PLACE=tab opens a tab in the agent's space", { skip: !hasJq && "needs jq" }, () => {
  const { bin, calls, artifact } = makeStubsWrapped();
  const res = run(bin, [artifact], { LAVISH_HERDR_PLACE: "tab" });
  assert.equal(res.status, 0, res.stderr?.toString());
  const tab = lines(calls, "herdr-app").find((l) => l.includes("tab.new"));
  assert.ok(tab, "tab.new called");
  assert.match(tab, /--space s1 --name Lavish --mod lavish/);
});

