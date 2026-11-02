import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, symlinkSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const install = join(root, "install.sh");

test("install.sh links mod, launcher and skill, then checks the mod", () => {
  const home = mkdtempSync(join(tmpdir(), "lavish-install-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "calls");
  mkdirSync(calls);
  writeFileSync(join(bin, "herdr-app"), `#!/bin/sh
echo "herdr-app $*" >> '${calls}/herdr-app'
exit 0
`);
  execFileSync("chmod", ["+x", join(bin, "herdr-app")]);

  const res = spawnSync("sh", [install], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: join(home, ".config", "herdr-app") },
  });
  assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);

  assert.equal(readlinkSync(join(home, ".config", "herdr-app", "mods", "lavish")), join(root, "mods", "lavish"));
  assert.equal(readlinkSync(join(home, ".local", "bin", "lavish-herdr")), join(root, "bin", "lavish-herdr"));
  assert.equal(readlinkSync(join(home, ".claude", "skills", "lavish-herdr")), join(root, "skill", "lavish-herdr"));

  const checkCalls = readFileSync(join(calls, "herdr-app"), "utf8").trim().split("\n").filter((l) => l.includes("check"));
  assert.deepEqual(checkCalls, [`herdr-app check ${join(home, ".config", "herdr-app", "mods", "lavish")}`]);

  rmSync(home, { recursive: true, force: true });
});
