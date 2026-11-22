const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs/promises");
const {join, resolve} = require("node:path");
const {tmpdir} = require("node:os");
const {createHash} = require("node:crypto");
const {crc32} = require("node:zlib");
const {spawnSync} = require("node:child_process");
const catalogs = require("../../build/electron/catalogs");
const projects = require("../../build/electron/projects");
const system = require("../../build/electron/system");
const {exportAnalysis} = require("../../build/electron/reports");

async function directory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "deptriagem-audit-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}));
  return root;
}
const hash = data => createHash("sha256").update(data).digest("hex");

function storedZip(id, record) {
  const name = Buffer.from(id + ".json");
  const data = Buffer.from(JSON.stringify(record));
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test("cada catálogo OSV passa pelo scanner offline antes de substituir a cópia anterior", async t => {
  const root = await directory(t);
  const canaries = {npm: "CVE-2021-23337", PyPI: "CVE-2024-56201", NuGet: "CVE-2024-21907"};
  let corrupt = false;
  t.mock.method(system, "download", async (url, path) => {
    const source = Object.keys(canaries).find(name => url.includes("/" + name + "/"));
    const id = canaries[source];
    const payload = storedZip(id, {id, affected: [{package: {ecosystem: source}}], extra: corrupt});
    await fs.writeFile(path, payload);
    return {sha256: hash(payload), bytes: payload.length};
  });
  const checked = [];
  t.mock.method(system, "run", async (program, args, options) => {
    assert.equal(program, "scanner-local");
    if (args[0] === "--version") return {code: 0, output: Buffer.from("osv-scanner version: 2.7.1")};
    assert.ok(args.includes("--offline") && args.includes("--no-resolve"));
    const probe = JSON.parse(await fs.readFile(join(options.cwd, "control.json"), "utf8"));
    const {package: pkg} = probe.results[0].packages[0];
    await fs.access(join(options.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY, "osv-scalibr", pkg.ecosystem, "all.zip"));
    checked.push(pkg.ecosystem);
    await fs.writeFile(args[args.indexOf("--output-file") + 1], JSON.stringify({results: [{packages: [{
      package: pkg, vulnerabilities: corrupt ? [] : [{id: "GHSA-exemplo", aliases: [canaries[pkg.ecosystem]]}],
    }]}]}));
    return {code: corrupt ? 0 : 1, diagnostics: "", output: Buffer.alloc(0)};
  });
  for (const source of Object.keys(canaries)) {
    const result = await catalogs.syncCatalogs(root, source, undefined, "scanner-local");
    assert.equal(result[source].positive_control.advisory, canaries[source]);
  }
  assert.deepEqual(checked, ["npm", "PyPI", "NuGet"]);
  const previous = await catalogs.snapshot(root, "npm", true);
  corrupt = true;
  const failed = await catalogs.syncCatalogs(root, "npm", undefined, "scanner-local");
  assert.match(failed.npm.error, /Controle positivo.*CVE-2021-23337/);
  assert.deepEqual(await catalogs.snapshot(root, "npm", true), previous);
});

test("CVSS v2, v3 e v4 e correções publicadas são preservados por advisory", () => {
  const pkg = {name: "Example_Package", version: "1.2.0", ecosystem: "PyPI"};
  const base = {id: "CVE-2025-1234", aliases: ["GHSA-test-a"]};
  const metadata = new Map([["PyPI", new Map([["CVE-2025-1234", {...base, severity: [
    {type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:C/I:C/A:C"},
    {type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"},
    {type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H"},
  ], database_specific: {severity: "MODERATE"}, affected: [
    {package: {ecosystem: "PyPI", name: "example-package"}, ranges: [{type: "ECOSYSTEM", events: [{fixed: "1.2.1"}]}]},
    {package: {ecosystem: "npm", name: "example-package"}, ranges: [{events: [{fixed: "99.0.0"}]}]},
  ]}]])]]);
  const kev = {count: 1, dateReleased: new Date().toISOString(), vulnerabilities: [{cveID: base.id}]};
  const other = {id: "GHSA-test-a", aliases: [base.id], severity: [{type: "CVSS_V3", score: "invalid"}],
    affected: [{package: pkg, ranges: [{events: [{fixed: "1.3.0"}]}]}]};
  const report = projects.summarize({results: [{source: {path: "requirements.txt"},
    packages: [{package: pkg, vulnerabilities: [base, other]}]}]}, kev, 14, metadata);
  const [finding] = report.findings;
  assert.equal(finding.priority, "maximum");
  assert.equal(finding.severity, "critical");
  assert.equal(finding.advisories[0].published_severity, "medium");
  assert.deepEqual(finding.advisories[0].cvss.map(metric => metric.base_score), [10, 9.8, 10]);
  assert.equal(finding.advisories[1].cvss[0].base_score, null);
  assert.deepEqual(finding.fixed_versions, ["1.2.1", "1.3.0"]);
  assert.equal(finding.fix_disagreement, true);
});

test("auditoria do commit Git guarda a revisão e lê os lockfiles originais", async t => {
  const root = await directory(t);
  const git = (...args) => {
    const result = spawnSync("git", args, {cwd: root, encoding: "utf8", windowsHide: true});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  const lock = join(root, "requirements.txt");
  await fs.writeFile(lock, "example==1.0\n");
  git("add", "requirements.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  const oldBlob = git("show", "HEAD:requirements.txt");
  await fs.writeFile(lock, "example==2.0\n");
  t.mock.method(catalogs, "scanner", async () => ({version: "2.7.1", executable: "fixture"}));
  t.mock.method(catalogs, "snapshot", async () => null);
  const input = {kind: "local", target: root, catalog_dir: root};
  const fixed = await projects.analyze({...input, commit: "HEAD"});
  const current = await projects.analyze(input);
  assert.equal(fixed.source.commit, commit);
  assert.equal(fixed.source.revision, "commit");
  assert.equal(fixed.inventory.lockfiles[0].sha256, hash(oldBlob + "\n"));
  assert.notEqual(current.inventory.lockfiles[0].sha256, fixed.inventory.lockfiles[0].sha256);
  assert.equal(await fs.readFile(lock, "utf8"), "example==2.0\n");
  await assert.rejects(projects.analyze({...input, commit: "--help"}), /commit Git local/);
});

test("resolve executáveis só pelo PATH absoluto fora da pasta de trabalho", async t => {
  const temp = await directory(t);
  const project = join(temp, "project");
  const tools = join(temp, "tools");
  await fs.mkdir(join(project, "bin"), {recursive: true});
  await fs.mkdir(tools);
  const program = process.platform === "win32" ? "deptriagem-test.exe" : "deptriagem-test";
  const {delimiter} = require("node:path");
  const localEntries = ["", ".", "bin", project, join(project, "bin")].join(delimiter);
  await fs.writeFile(join(project, program), "", {mode: 0o700});
  await fs.writeFile(join(project, "bin", program), "", {mode: 0o700});
  await fs.writeFile(join(tools, program), "", {mode: 0o700});
  await assert.rejects(system.resolveExecutable(program, {PATH: localEntries}, project), /PATH/);
  assert.equal(await system.resolveExecutable(program, {PATH: localEntries + delimiter + tools}, project),
    join(tools, program));
  if (process.platform !== "win32") {
    const alias = join(tools, "alias-test");
    await fs.symlink(join(tools, program), alias);
    assert.equal(await system.resolveExecutable("alias-test", {PATH: tools}, project), alias);
  }
});

test("inventaria requirements nomeados e informa arquivos de dependências ignorados", async t => {
  const root = await directory(t);
  const init = spawnSync("git", ["init", "-q"], {cwd: root, windowsHide: true});
  assert.equal(init.status, 0, init.stderr?.toString());
  await fs.writeFile(join(root, ".gitignore"), "cache/\n");
  await fs.mkdir(join(root, "cache"));
  await fs.mkdir(join(root, "build"));
  await fs.mkdir(join(root, "requirements"));
  await fs.writeFile(join(root, "cache", "requirements-hidden.txt"), "fixture==1.0\n");
  await fs.writeFile(join(root, "build", "requirements-dev.txt"), "fixture==2.0\n");
  await fs.writeFile(join(root, "dev-requirements.txt"), "fixture==2.0\n");
  await fs.writeFile(join(root, "test-requirements.txt"), "fixture==2.0\n");
  await fs.writeFile(join(root, "requirements", "dev.txt"), "fixture==2.0\n");
  for (const [index, newline] of ["\n", "\r", "\u2028", "\u2029"].entries()) {
    for (const ext of ["py", "js", "cs"]) await fs.writeFile(join(root, `blank-${index}.${ext}`), newline.repeat(40_000));
  }
  await fs.writeFile(join(root, "normal.py"), "import fixture\n");
  t.mock.method(catalogs, "scanner", async () => ({version: "2.7.1", executable: "fixture"}));
  t.mock.method(catalogs, "snapshot", async () => null);
  const started = performance.now();
  const report = await projects.analyze({kind: "local", target: root, catalog_dir: root});
  assert.ok(performance.now() - started < 8000, "a leitura de imports deve permanecer linear");
  assert.deepEqual(report.inventory.lockfiles.map(item => item.path).sort(),
    ["build/requirements-dev.txt", "dev-requirements.txt", "requirements/dev.txt", "test-requirements.txt"]);
  assert.equal(report.inventory.lockfiles[0].sha256, hash("fixture==2.0\n"));
  assert.equal(report.coverage, "partial");
  assert.ok(report.coverage_issues.some(item => item.reason === "lockfile_ignored_by_git" &&
    item.path === "cache/requirements-hidden.txt"));
  assert.deepEqual(report.inventory.import_hints.Python, ["fixture"]);
});

test("Git isolado mantém submódulos e repositórios internos como lacunas", async t => {
  const root = await directory(t);
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, {cwd, encoding: "utf8", windowsHide: true});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(root, "init", "-q");
  await fs.writeFile(join(root, ".gitignore"), "cache/\n");
  await fs.writeFile(join(root, "requirements.txt"), "fixture==1.0\n");
  git(root, "add", ".");
  const commit = () => git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  commit();
  git(root, "update-index", "--add", "--cacheinfo", "160000," + git(root, "rev-parse", "HEAD") + ",module");
  commit();
  for (const path of ["nested", "cache/inner"]) {
    const folder = join(root, path);
    await fs.mkdir(folder, {recursive: true});
    git(folder, "init", "-q");
  }
  git(root, "config", "deptriagem.fixture", "original-local");
  const isolated = await require("../../build/electron/git-inventory").isolatedGit(root, root, true);
  try {
    const value = await isolated.git(["config", "--local", "--get", "deptriagem.fixture"]);
    assert.notEqual(value.code, 0);
    assert.equal(value.output.length, 0);
  } finally { await isolated.dispose(); }
  const run = system.run;
  t.mock.method(system, "run", async (program, args, options) => {
    const tree = args.find(arg => arg.startsWith("--work-tree="));
    assert.ok(tree && !tree.includes(root));
    assert.equal(args.includes("--others"), false);
    return run(program, args, options);
  });
  t.mock.method(catalogs, "scanner", async () => ({version: "2.7.1", executable: "fixture"}));
  t.mock.method(catalogs, "snapshot", async () => null);
  const input = {kind: "local", target: root, catalog_dir: root};
  const worktree = await projects.analyze(input);
  const fixed = await projects.analyze({...input, commit: "HEAD"});
  const nested = report => report.coverage_issues.filter(item => item.reason === "nested_repository").map(item => item.path).sort();
  assert.deepEqual(nested(worktree), ["cache/inner", "module", "nested"]);
  assert.deepEqual(nested(fixed), ["module"]);
});

test("preserva regras Git e arquivos longos, incluindo o índice dividido", async t => {
  const folder = await directory(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.longpaths=true", ...args], {cwd: folder, encoding: "utf8", windowsHide: true});
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  const parent = join(folder, ...Array.from({length: 7}, (_, index) => `folder-${index}-` + "a".repeat(43)));
  await fs.mkdir(parent, {recursive: true});
  await fs.writeFile(join(folder, ".gitignore"), "requirements-hidden.txt\n");
  for (const name of ["requirements-tracked.txt", "requirements-new.txt", "requirements-hidden.txt"]) {
    await fs.writeFile(join(parent, name), "fixture==1.0\n");
  }
  git("add", join(parent, "requirements-tracked.txt"));
  git("update-index", "--split-index");
  const paths = [];
  for await (const file of projects.localFiles(folder, true)) paths.push([file.path.split("/").at(-1), Boolean(file.read)]);
  assert.ok(paths.some(([name, read]) => name === "requirements-tracked.txt" && read));
  assert.ok(paths.some(([name, read]) => name === "requirements-new.txt" && read));
  assert.ok(paths.some(([name, read]) => name === "requirements-hidden.txt" && !read));
  const plain = join(folder, "plain");
  await fs.mkdir(join(plain, ".git"), {recursive: true});
  assert.equal((await require("../../build/electron/git-inventory").findGitFolder(plain)).root, folder);
});

test("lê commits locais com referências reftable", async t => {
  const root = await directory(t);
  const git = (...args) => spawnSync("git", args, {cwd: root, encoding: "utf8", windowsHide: true});
  const init = git("init", "-q", "--ref-format=reftable");
  if (init.status) { t.skip("Git local sem reftable"); return; }
  await fs.writeFile(join(root, "requirements.txt"), "fixture==1.0\n");
  assert.equal(git("add", "requirements.txt").status, 0);
  assert.equal(git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture").status, 0);
  t.mock.method(catalogs, "scanner", async () => ({version: "2.7.1", executable: "fixture"}));
  t.mock.method(catalogs, "snapshot", async () => null);
  const result = await projects.analyze({kind: "local", target: root, commit: "HEAD", catalog_dir: root});
  assert.equal(result.source.commit, git("rev-parse", "HEAD").stdout.trim());
  assert.equal(result.inventory.lockfiles[0].path, "requirements.txt");
});

test("arquivos ausentes marcados skip-worktree aparecem como lacunas", async t => {
  const root = await directory(t);
  const git = (...args) => {
    const result = spawnSync("git", args, {cwd: root, encoding: "utf8", windowsHide: true});
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  await fs.writeFile(join(root, "requirements-hidden.txt"), "fixture==1.0\n");
  git("add", "requirements-hidden.txt");
  git("update-index", "--skip-worktree", "requirements-hidden.txt");
  await fs.unlink(join(root, "requirements-hidden.txt"));
  const result = [];
  for await (const file of projects.localFiles(root, true)) result.push(file);
  assert.ok(result.some(item => item.path === "requirements-hidden.txt" && item.gap === "git_metadata_not_inspected"));
});

test("arquivos especiais, regras grandes e lotes de exclusão preservam o inventário", async t => {
  const root = await directory(t);
  assert.equal(spawnSync("git", ["init", "-q"], {cwd: root, windowsHide: true}).status, 0);
  await fs.writeFile(join(root, ".gitignore"), "large/\n");
  await fs.mkdir(join(root, "large"));
  await fs.writeFile(join(root, "large", ".gitignore"), "#".repeat(1024 ** 2 + 1));
  await fs.writeFile(join(root, "large", "requirements-hidden.txt"), "fixture==1.0\n");
  await fs.writeFile(join(root, "requirements.txt"), "fixture==1.0\n");
  if (process.platform !== "win32") {
    await fs.writeFile(join(root, ":(zzz)module.py"), "");
    await fs.mkdir(Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff])]));
  }
  for (let start = 0; start < 600; start += 50) {
    await Promise.all(Array.from({length: 50}, (_, index) => fs.writeFile(join(root, `empty-${start+index}.log`), "")));
  }
  const originalRun = system.run;
  const batches = [];
  t.mock.method(system, "run", async (program, args, options) => {
    if (args.includes("check-ignore")) batches.push(options.input);
    return originalRun(program, args, options);
  });
  const results = [];
  for await (const file of projects.localFiles(root, true)) results.push(file);
  assert.ok(batches.length <= 2);
  assert.ok(batches.every(input => !input.includes(".log")));
  assert.ok(results.some(item => item.path === "requirements.txt" && item.read));
  assert.ok(results.some(item => item.path === "large" && item.gap));
  assert.ok(results.some(item => item.path === "large/requirements-hidden.txt" && !item.read));
});

function stubOfflineScanner() {
  const fs = require("node:fs/promises");
  const {join, resolve} = require("node:path");
  const catalogs = require(resolve("build/electron/catalogs"));
  const system = require(resolve("build/electron/system"));
  catalogs.scanner = async () => ({executable: "fixture-scanner", version: "2.7.1"});
  catalogs.snapshot = async (_root, source) => ({
    path: join(__dirname, source + ".fixture"),
    meta: {downloaded_at: new Date().toISOString(), source_updated_at: null},
  });
  const run = system.run;
  system.run = async (program, args, options) => {
    if (program !== "fixture-scanner") return run(program, args, options);
    const results = [];
    for (const folder of await fs.readdir(options.cwd)) {
      for (const name of await fs.readdir(join(options.cwd, folder))) {
        const python = name === "requirements.txt";
        results.push({source: {path: join(folder, name)}, packages: [{
          package: {name: "fixture", version: "1.0", ecosystem: python ? "PyPI" : "npm"},
          vulnerabilities: python ? [{id: "GHSA-fixture"}] : [],
        }]});
      }
    }
    await fs.writeFile(args[args.indexOf("--output-file") + 1], JSON.stringify({results}));
    return {code: 0, output: Buffer.alloc(0), diagnostics: ""};
  };
}

test("a CLI e o MCP incluem lockfiles, manifestos e código permitido pelo Git", async t => {
  const scratch = await directory(t);
  const hook = join(scratch, "scanner.cjs");
  await fs.writeFile(hook, "(" + stubOfflineScanner.toString() + ")();");
  await fs.writeFile(join(scratch, "KEV.fixture"), JSON.stringify({
    count: 1, dateReleased: new Date().toISOString(), vulnerabilities: [{cveID: "CVE-2000-0001"}],
  }));
  for (const ecosystem of ["npm", "PyPI"]) {
    await fs.writeFile(join(scratch, ecosystem + ".fixture"), storedZip("GHSA-fixture", {id: "GHSA-fixture"}));
  }
  const rules = [
    ["global", ".gitignore", "*\n!*/\n!*.txt\n!*.json\n!*.py\n", "sub"],
    ["ancorada", ".gitignore", "sub/*\n!sub/*.txt\n!sub/*.json\n!sub/*.py\n", "sub"],
    ["recursiva", ".gitignore", "sub/**\n!sub/**/\n!sub/**/*.txt\n!sub/**/*.json\n!sub/**/*.py\n", "sub/deep"],
    ["aninhada", "sub/.gitignore", "*\n!*.txt\n!*.json\n!*.py\n", "sub"],
    ["utf16-lf", ".gitignore", Buffer.from("\uFEFF*.log\n", "utf16le"), "sub"],
    ["utf16-crlf", ".gitignore", Buffer.from("\uFEFF*.log\r\n", "utf16le"), "sub"],
  ];
  if (process.platform === "win32") {
    const pairs = [["k", "\u212a"], ["\u03c9", "\u2126"], ["\u00df", "\u1e9e"], ["\u00e5", "\u212b"]];
    for (const [ignored, included] of pairs) {
      rules.push(["unicode-" + included.codePointAt(0).toString(16), ".gitignore",
        "/" + ignored + "/\n", included, ignored]);
    }
  }
  const cases = [
    ["requirements.txt", "fixture==1.0\n", result => assert.equal(result.findings[0]?.ecosystem, "PyPI")],
    ["package.json", '{"name":"fixture"}', result => assert.ok(result.coverage_issues.includes("manifest_without_scanned_lockfile"))],
    ["app.py", "pass\n", result => assert.ok(result.coverage_issues.includes("language_without_lockfile"))],
  ];
  const mcpInput = [
    {id: 1, method: "initialize", params: {protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {name: "fixture", version: "1"}}},
    {method: "notifications/initialized"},
    {id: 2, method: "tools/call", params: {name: "analyze_dependencies", arguments: {}}},
  ].map(message => JSON.stringify({jsonrpc: "2.0", ...message})).join("\n") + "\n";
  for (const [label, ignore, contents, sub, excluded] of rules) for (const [name, data, check] of cases) {
    await t.test(label + "/" + name, async () => {
      const root = join(scratch, label + "-" + name);
      await fs.mkdir(join(root, sub), {recursive: true});
      const git = spawnSync("git", ["init", "-q"], {cwd: root, encoding: "utf8", windowsHide: true});
      assert.equal(git.status, 0, git.stderr);
      await fs.writeFile(join(root, ignore), contents);
      await fs.writeFile(join(root, "package-lock.json"), '{"name":"fixture","lockfileVersion":3,"packages":{}}');
      if (excluded) {
        await fs.mkdir(join(root, excluded));
        await fs.writeFile(join(root, excluded, name), data);
      }
      await fs.writeFile(join(root, sub, name), data);
      const options = {env: {...process.env, DEPTRIAGEM_DATA_DIR: join(scratch, "profile")},
        encoding: "utf8", windowsHide: true, timeout: 20_000};
      const entry = ["--require", hook, resolve("build/electron/cli.js")];
      const cli = spawnSync(process.execPath, [...entry, "analyze", "--local", root], options);
      assert.equal(cli.status, name === "requirements.txt" && !excluded ? 1 : 2, cli.error?.message ?? cli.stderr);
      const report = JSON.parse(cli.stdout);
      if (excluded && name === "requirements.txt") {
        assert.equal(report.findings[0]?.source, sub + "/" + name);
        assert.ok(report.coverage_issues.some(issue => issue.path === excluded + "/" + name &&
          issue.reason === "lockfile_ignored_by_git"));
      }
      check({...report, coverage_issues: report.coverage_issues.map(issue => issue.reason)});
      const rpc = spawnSync(process.execPath, [...entry, "mcp", "serve", "--root", root],
        {...options, input: mcpInput});
      assert.equal(rpc.status, 0, rpc.error?.message ?? rpc.stderr);
      const result = rpc.stdout.trim().split("\n").map(line => JSON.parse(line)).find(message => message.id === 2)?.result;
      assert.ok(result && !result.isError, rpc.stdout);
      check(JSON.parse(result.content[0].text));
    });
  }
});

test("no Windows o inventário distingue nomes Unicode e preserva caminhos rastreados", {
  skip: process.platform !== "win32",
}, async t => {
  const root = await directory(t);
  const git = (...args) => {
    const result = spawnSync("git", args, {cwd: root, encoding: "utf8", windowsHide: true});
    assert.equal(result.status, 0, result.stderr);
  };
  async function lock(folder) {
    await fs.mkdir(join(root, folder));
    await fs.writeFile(join(root, folder, "requirements.txt"), "fixture==1.0\n");
  }
  git("init", "-q");
  for (const folder of ["k", "AUXILIAR", "AÇÃO"]) await lock(folder);
  git("add", ".");
  git("update-index", "--skip-worktree", "k/requirements.txt", "AUXILIAR/requirements.txt");
  await fs.unlink(join(root, "k/requirements.txt"));
  await lock("\u212a");
  for (const [before, after] of [["AUXILIAR", "auxiliar"], ["AÇÃO", "ação"]]) {
    await fs.rename(join(root, before), join(root, "temporary"));
    await fs.rename(join(root, "temporary"), join(root, after));
  }
  await fs.writeFile(join(root, ".gitignore"), "aç*/\n");
  const files = [];
  for await (const file of projects.localFiles(root, true)) files.push(file);
  assert.ok(files.some(file => file.path === "k/requirements.txt" && file.gap === "git_metadata_not_inspected"));
  for (const folder of ["auxiliar", "ação", "\u212a"]) {
    assert.ok(files.some(file => file.path === folder + "/requirements.txt" && file.read), folder);
  }
  assert.ok(!files.some(file => file.path === "AUXILIAR/requirements.txt" && file.gap));
});

test("regras aninhadas do Git respeitam a capitalização da plataforma", async t => {
  const root = await directory(t);
  const git = spawnSync("git", ["init", "-q"], {cwd: root, encoding: "utf8", windowsHide: true});
  assert.equal(git.status, 0, git.stderr);
  await fs.mkdir(join(root, "sub"));
  await fs.writeFile(join(root, "sub", ".GITIGNORE"), "requirements.txt\n");
  await fs.writeFile(join(root, "sub", "requirements.txt"), "fixture==1.0\n");
  let included = false;
  for await (const file of projects.localFiles(root, true)) {
    if (file.path === "sub/requirements.txt" && file.read) included = true;
  }
  assert.equal(included, process.platform !== "win32");
});

test("perfil explícito ignora vizinhos e falhas de migração permanecem no stderr", async t => {
  const root = await directory(t);
  const previous = join(root, "DevTools"), target = join(root, "DepTriagem");
  await fs.mkdir(join(previous, "catalogs"), {recursive: true});
  await fs.mkdir(target);
  for (const scanner of [join(previous, "fixture-scanner.exe"), "fixture-scanner.exe"]) {
    await fs.writeFile(join(previous, "settings.json"), JSON.stringify({scanner}));
    const run = spawnSync(process.execPath, ["build/electron/cli.js", "catalogs", "status"], {
      env: {...process.env, DEPTRIAGEM_DATA_DIR: target}, encoding: "utf8", windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    await assert.rejects(fs.access(join(target, "settings.json")), {code: "ENOENT"});
  }
  if (process.platform !== "win32") return;
  await fs.writeFile(join(previous, "catalogs", "KEV.json"), "{}");
  await fs.writeFile(join(target, "catalogs"), "destino indisponível");
  const env = {...process.env, LOCALAPPDATA: root};
  delete env.DEPTRIAGEM_DATA_DIR;
  const init = {jsonrpc:"2.0", id:1, method:"initialize",
    params:{protocolVersion:"2025-11-25", capabilities:{}, clientInfo:{name:"fixture",version:"1"}}};
  const response = spawnSync(process.execPath, ["build/electron/cli.js", "mcp", "serve"], {
    env, encoding: "utf8", input: JSON.stringify(init) + "\n", windowsHide: true,
  });
  assert.equal(response.status, 0);
  assert.match(response.stderr, /migração.*incompleta/);
  assert.equal(JSON.parse(response.stdout).result.protocolVersion, "2025-11-25");
});

test("migração ajusta caminhos antigos e só copia o scanner com hash esperado", async t => {
  const root = await directory(t);
  const previous = join(root, "previous"), target = join(root, "current");
  await fs.mkdir(join(previous, "custom-catalogs"), {recursive: true});
  await fs.mkdir(join(previous, "tools"));
  const [binary] = catalogs.scannerAsset;
  const buffer = Buffer.from("scanner fictício, nunca executado");
  const oldScanner = join(previous, "tools", binary);
  await fs.writeFile(oldScanner, buffer);
  catalogs.scannerAsset = [binary, hash(buffer)];
  const oldConfig = {scanner: oldScanner, catalog_dir: join(previous, "custom-catalogs"), reports_dir: join(previous, "reports")};
  await fs.writeFile(join(previous, "settings.json"), JSON.stringify(oldConfig));
  await fs.writeFile(join(oldConfig.catalog_dir, "KEV.json"), "{}");
  const {migrateProfile} = require("../../build/electron/migration");
  await migrateProfile(previous, target);
  assert.deepEqual(JSON.parse(await fs.readFile(join(target, "settings.json"), "utf8")),
    {catalog_dir: join(target, "catalogs"), reports_dir: join(target, "reports")});
  assert.deepEqual(await fs.readFile(join(target, "tools", binary)), buffer);
  assert.deepEqual(JSON.parse(await fs.readFile(join(previous, "settings.json"), "utf8")), oldConfig);
  await fs.writeFile(oldScanner, "adulterado");
  await migrateProfile(previous, join(root, "other"));
  await assert.rejects(fs.access(join(root, "other", "tools", binary)), {code: "ENOENT"});
});

test("migração copia catálogo e preferências sem sobrescrever ou copiar credenciais", async t => {
  const root = await directory(t);
  const previous = join(root, "previous"), target = join(root, "current");
  await fs.mkdir(join(previous, "catalogs"), {recursive: true});
  await fs.mkdir(target);
  await fs.writeFile(join(previous, "settings.json"), '{"theme":"dark"}');
  await fs.writeFile(join(previous, "launcher-token.json"), "{}");
  await fs.writeFile(join(previous, "catalogs", "KEV.json"), "{}");
  await fs.writeFile(join(target, "settings.json"), '{"theme":"light"}');
  const {migrateProfile} = require("../../build/electron/migration");
  await migrateProfile(previous, target);
  await migrateProfile(previous, target);
  assert.equal(await fs.readFile(join(target, "settings.json"), "utf8"), '{"theme":"light"}');
  assert.equal(await fs.readFile(join(previous, "settings.json"), "utf8"), '{"theme":"dark"}');
  assert.equal(await fs.readFile(join(target, "catalogs", "KEV.json"), "utf8"), "{}");
  await assert.rejects(fs.access(join(target, "launcher-token.json")), {code: "ENOENT"});
});

test("exportação produz Markdown e separa o parecer com o SHA-256 do JSON", async t => {
  const root = await directory(t);
  const path = join(root, "exportado");
  const report = {schema_version: 1, source: {directory: "<img src=x>", commit: "abc"}, coverage: "partial",
    coverage_issues: [], generated_at: "2026-11-22", scanner_version: "2.7.1", packages_reported: 0, findings: [],
    model_guidance: {status: "suggestions", checks: ["fixture"]}, model_decision: {queue: "needs_review"}};
  const result = await exportAnalysis(path, report);
  assert.deepEqual(result.files, ["relatorio.json", "relatorio.md", "parecer-ia.json"]);
  const official = await fs.readFile(join(path, "relatorio.json"));
  const markdown = await fs.readFile(join(path, "relatorio.md"), "utf8");
  const advisory = JSON.parse(await fs.readFile(join(path, "parecer-ia.json"), "utf8"));
  assert.equal(advisory.report_sha256, hash(official));
  assert.equal(JSON.parse(official).model_guidance, undefined);
  assert.equal(advisory.model_decision.queue, "needs_review");
  assert.match(markdown, /&lt;img src=x&gt;/);
  await assert.rejects(exportAnalysis(path, report), /já existe/);
  assert.ok((await fs.readFile(join(path, "relatorio.json"))).equals(official));
});
