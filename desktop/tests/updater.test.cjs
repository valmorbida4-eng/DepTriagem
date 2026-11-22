const assert = require("node:assert/strict");
const {spawn, spawnSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const {existsSync, mkdtempSync, readFileSync, writeFileSync} = require("node:fs");
const {rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join, resolve} = require("node:path");
const {test} = require("node:test");
const {setTimeout: wait} = require("node:timers/promises");

test("Windows update helper outlives its caller and records the installer outcome",
  {skip: process.platform !== "win32", timeout: 110_000}, async t => {
    const compiler = join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (!existsSync(compiler)) return t.skip("The Windows .NET fixture compiler is unavailable.");
    const temp = mkdtempSync(join(tmpdir(), "deptriagem-installer-test-"));
    // The detached helper may still hold its working directory after recording the result.
    t.after(() => rm(temp, {recursive: true, force: true, maxRetries: 20, retryDelay: 100}));
    const source = join(temp, "fixture.cs"), exe = join(temp, "fixture.exe");
    writeFileSync(source, `
      using System;
      class Fixture {
        public static int Main(string[] args) {
          if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("deptriagem 9.0.0"); return 0; }
          if (Array.IndexOf(args, "/currentuser") < 0 || Array.IndexOf(args, "/S") < 0) return 42;
          return Environment.GetEnvironmentVariable("DEPTRIAGEM_FIXTURE_FAIL") == "1" ? 7 : 0;
        }
      }
    `);
    const compiled = spawnSync(compiler, ["/nologo", "/target:winexe", "/out:" + exe, source], {encoding: "utf8", timeout: 10_000});
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    const digest = createHash("sha256").update(readFileSync(exe)).digest("hex");
    const updateModule = resolve(__dirname, "../../build/electron/updates.js");
    const launch = 'const [p,e,d]=process.argv.slice(1); require(p).launchVerifiedUpdate(e,e,d,"9.0.0",false).catch(error=>{console.error(error);process.exitCode=1;});';
    for (const fail of [true, false]) {
      const profile = join(temp, fail ? "failure" : "success");
      const child = spawn(process.execPath, ["-e", launch, updateModule, exe, digest], {stdio: "inherit",
        env: {...process.env, DEPTRIAGEM_DATA_DIR: profile, DEPTRIAGEM_FIXTURE_FAIL: fail ? "1" : "0"}});
      const code = await new Promise((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });
      assert.equal(code, 0);
      let result;
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        await wait(100);
        try { result = JSON.parse(readFileSync(join(profile, "updates", "last-update.json"), "utf8").replace(/^\uFEFF/, "")); }
        catch { continue; }
        if (["failed", "complete"].includes(result.phase)) break;
      }
      assert.equal(result?.phase, fail ? "failed" : "complete", JSON.stringify(result));
      assert.equal(result.exit_code, fail ? 7 : 0, JSON.stringify(result));
      if (fail) assert.equal(result.reason, "installer");
    }
  });
