const {once} = require("node:events");
const http = require("node:http");
const assert = require("node:assert/strict");
const {test} = require("node:test");
const projects = require("../../build/electron/projects.js");
const launcher = require("../../build/electron/launcher.js");
const updates = require("../../build/electron/updates.js");

test("prioriza CVE no KEV sem duplicar aliases do mesmo pacote", () => {
  const output = projects.summarize({results: [{source: {path: "uv.lock"}, packages: [{
    package: {name: "demo", version: "1.0", ecosystem: "PyPI"},
    vulnerabilities: [{id: "GHSA-test", aliases: ["CVE-2025-0001"]}, {id: "CVE-2025-0001"}],
  }]}]}, {count: 1, dateReleased: new Date().toISOString(), vulnerabilities: [{cveID: "CVE-2025-0001"}]});
  assert.equal(output.findings.length, 1);
  assert.equal(output.findings[0].priority, "maximum");
  assert.deepEqual(output.findings[0].ids, ["CVE-2025-0001", "GHSA-test"]);
});

test("limita a origem de repositório ao GitHub.com", () => {
  assert.equal(projects.repoName("https://github.com/owner/test.git"), "owner/test");
  for (const value of ["https://github.com.other.example/owner/repo", "git@github.com:owner/repo", "owner/.."]) {
    assert.throws(() => projects.repoName(value));
  }
});

test("ignora drafts e bloqueia checksum incompatível na atualização", () => {
  const validHash = "a".repeat(64);
  const asset = updates.updateAsset("9.0.0");
  const info = updates.selectRelease([
    {tag_name: "v9.0.0", draft: true, assets: []},
    {tag_name: "v9.0.0", assets: [{name: asset, state: "uploaded", size: 100, digest: "sha256:" + validHash},
      {name: asset + ".sha256", state: "uploaded"}]},
  ]);
  assert.equal(info.status, "available");
  assert.equal(info.sha256, validHash);
  assert.throws(() => updates.checksum("b".repeat(64) + "  " + asset, asset, validHash));
});

test("consulta o Launcher em loopback e separa a triagem do parecer", async t => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    received.push({path: request.url, text, token: request.headers.authorization});
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/control/state") return response.end(JSON.stringify({
      version: 1, models: [], servers: {chat: null, decider: null},
    }));
    if (request.url === "/v1/systemone") return response.end(JSON.stringify({answers: {routing: {
      type: "choice", choice: "security", probabilities: {security: .9, functional_bug: .03, needs_review: .07},
    }}}));
    response.end(JSON.stringify({choices: [{message: {content: "Encaminhe para revisão humana."}}]}));
  }).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const port = server.address().port;
  await launcher.control("state", {port, token: "teste-apenas"});
  const result = await launcher.triage("Texto restrito do relato", port, .8, {port});
  assert.equal(result.queue, "security");
  assert.match(result.note, /revisão humana/);
  assert.equal(received[0].token, "Bearer teste-apenas");
  assert.match(received[1].text, /Texto restrito do relato/);
  assert.doesNotMatch(received[2].text, /Texto restrito do relato/);
});

test("classifica por SystemOne ou chat local sem consultar o controle do Launcher", async t => {
  const calls = [];
  const routing = {choice: "functional_bug", probabilities: {security: .03, functional_bug: .93, needs_review: .04}};
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const payload = JSON.parse(request.body);
    calls.push({url, payload, redirect: request.redirect});
    if (String(url).endsWith("/v1/systemone")) return Response.json({answers: {
      routing: {type: "choice", ...routing},
    }});
    const content = payload.response_format ?
      JSON.stringify(payload.model === "resposta-invalida" ? {...routing, probabilities: {functional_bug: 1}} : routing)
      : "Confirme em revisão humana.";
    return Response.json({choices: [{message: {content}}]});
  });
  const systemone = await launcher.triage("Relato fictício", {mode: "systemone", port: 8099});
  assert.equal(systemone.queue, "functional_bug");
  const chat = await launcher.triage("Relato fictício", {mode: "chat", port: 8077, model: "teste-local"},
    .8, {port: 8077, model: "teste-local"});
  assert.equal(chat.queue, "functional_bug");
  assert.equal(chat.note, "Confirme em revisão humana.");
  assert.deepEqual(calls.map(call => call.url), [
    "http://127.0.0.1:8099/v1/systemone", "http://127.0.0.1:8077/v1/chat/completions", "http://127.0.0.1:8077/v1/chat/completions",
  ]);
  assert.ok(calls.every(call => call.redirect === "error"));
  assert.equal(calls[1].payload.model, "teste-local");
  assert.equal(calls[1].payload.response_format.type, "json_schema");
  assert.match(calls[1].payload.messages[1].content, /Relato fictício/);
  assert.doesNotMatch(JSON.stringify(calls[2].payload), /Relato fictício/);
  assert.deepEqual(await launcher.triage("Relato fictício", {mode: "chat", model: "resposta-invalida"}),
    {queue: "needs_review", reason: "decider_unavailable"});
  assert.throws(() => launcher.deciderConfig({mode: "outra-api"}));
});

test("o Decisor da análise recebe apenas o resumo agregado e preserva o relatório do scanner", async t => {
  const fs = require("node:fs/promises");
  const {join} = require("node:path");
  const {tmpdir} = require("node:os");
  const catalogs = require("../../build/electron/catalogs");
  const projects = require("../../build/electron/projects");
  const fixture = await fs.mkdtemp(join(tmpdir(), "deptriagem-analysis-decider-"));
  t.after(() => fs.rm(fixture, {recursive: true, force: true}));
  await fs.writeFile(join(fixture, "package.json"), JSON.stringify({name: "private-fixture-package"}));
  t.mock.method(catalogs, "scanner", async () => ({version: "2.0.0", executable: "fixture"}));
  t.mock.method(catalogs, "snapshot", async () => null);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const payload = JSON.parse(options.body);
    requests.push({url, payload});
    const result = {choice: "needs_review", probabilities: {needs_review: .92, priority_review: .05, routine_review: .03}};
    return Response.json({output: [{type: "message", content: [{type: "output_text", text: JSON.stringify(result)}]}]});
  });
  const config = {kind: "local", target: fixture, catalog_dir: fixture, decider: {mode: "openai", model: "fixture"}};
  const denied = await projects.analyze(config);
  assert.equal(denied.model_decision.reason, "external_not_authorized");
  assert.equal(requests.length, 0);
  const steps = [];
  const result = await projects.analyze({...config, allowExternal: true, credentials: {openai: "fake-key"}}, step => steps.push(step));
  assert.equal(result.model_decision.queue, "needs_review");
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.findings, denied.findings);
  assert.equal(requests.length, 1);
  const {input, text: {format}} = requests[0].payload;
  const envelope = JSON.parse(input);
  assert.deepEqual(Object.keys(envelope), ["report"]);
  assert.deepEqual(Object.keys(JSON.parse(envelope.report)).sort(),
    ["coverage", "coverage_issues", "findings_count", "maximum_priority_count", "packages_reported"]);
  assert.deepEqual(format.schema.properties.choice.enum, ["priority_review", "routine_review", "needs_review"]);
  assert.doesNotMatch(input, /private-fixture-package|package\.json|deptriagem-analysis-decider/);
  assert.equal(steps.find(step => step.completed === 5).total, 6);
  assert.equal(steps.at(-1).completed, 6);
});

test("seleciona o pacote de atualizacao do sistema e arquitetura", () => {
  assert.equal(updates.updateAsset("1.2.3", "win32", "x64"), "DepTriagem-Setup-1.2.3-win-x64.exe");
  assert.equal(updates.updateAsset("1.2.3", "linux", "arm64"), "DepTriagem-1.2.3-linux-arm64.AppImage");
  assert.equal(updates.updateAsset("1.2.3", "darwin", "x64"), "DepTriagem-1.2.3-mac-x64.dmg");
  assert.equal(updates.updateAsset("1.2.3", "freebsd", "x64"), undefined);
});


test("inventario Git segue gitignore e info/exclude sem perder arquivos rastreados", async t => {
  const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = require("node:fs");
  const {spawnSync} = require("node:child_process");
  const {join, dirname} = require("node:path");
  const folder = mkdtempSync(join(require("node:os").tmpdir(), "deptriagem-inventory-test-"));
  t.after(() => rmSync(folder, {recursive: true, force: true}));
  const git = (...args) => {
    const result = spawnSync("git", args, {cwd: folder, encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
  };
  const make = (name, data = "{}") => {
    const path = join(folder, name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, data);
  };
  git("init", "-q");
  make(".gitignore", "generated/\n");
  make(".git/info/exclude", ".claude/worktrees/\n");
  make(".claude/worktrees/review/package-lock.json");
  make("generated/package-lock.json");
  make("generated/intentional.json");
  make("app-src/package-lock.json");
  make("app-src/index.js");
  git("add", "-f", "generated/intentional.json");
  const files = [];
  for await (const file of projects.localFiles(folder)) files.push(file.path);
  assert.deepEqual(files.sort(), [".gitignore", "app-src/index.js", "app-src/package-lock.json", "generated/intentional.json"]);
  const nested = [];
  for await (const file of projects.localFiles(join(folder, "app-src"))) nested.push(file.path);
  assert.deepEqual(nested.sort(), ["index.js", "package-lock.json"]);
});

test("distingue timeout, falha HTTP e resposta invalida na orientacao local", async t => {
  const {testModel} = require("../../build/electron/models.js");
  const check = () => testModel({provider: "launcher", seconds: 180});
  let behavior;
  t.mock.method(globalThis, "fetch", async (_url, options) => behavior(options));
  behavior = () => new Response(null, {status: 503});
  assert.deepEqual(await check(), {status: "unavailable_or_invalid", reason: "http", http_status: 503, port: 8080});
  behavior = () => Response.json({choices: [{message: {content: "fake"}}]});
  assert.equal((await check()).reason, "invalid");
  behavior = () => Response.json({choices: [{message: {content: "", reasoning_content: "texto fictício"}}]});
  assert.equal((await check()).reason, "invalid");
  const reasoned = await testModel({provider: "launcher", effort: "server"});
  assert.equal(reasoned.reason, "reasoning_only");
  assert.match(reasoned.detail, /Reduza o esforço/);
  behavior = options => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason));
  });
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => nativeTimeout(10));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await check()).reason, "timeout");
    const decision = await launcher.triage("Relato fictício", {mode: "launcher"});
    assert.equal(decision.queue, "needs_review");
    assert.match(decision.detail, /Tente um Decisor menor/);
  }
  finally { clearTimeout(keepAlive); }
});


test("preserva o erro estruturado do controle e oculta o token", async t => {
  const token = "fake-control-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    error: {code: "start_failed", message: "O motor encerrou antes de ficar pronto. " + token},
  }, {status: 500}));
  await assert.rejects(launcher.control("start", {role: "chat", model_id: "m_0011223344556677", token}), error =>
    error.httpStatus === 500 && /start_failed/.test(error.message) &&
    /motor encerrou/.test(error.message) && !error.message.includes(token));
});

test("consulta os dois servidores locais do Launcher separadamente", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("/state")) return Response.json({version:1,models:[],servers:{
      chat:{model_id:"m_0011223344556677",port:8080},decider:{model_id:"m_0123456789abcdef",port:8090},
    }});
    return new Response(null,{status:String(url).includes(":8080")?503:200});
  });
  const result = await launcher.watchLauncher({token:"ficticio"});
  assert.deepEqual(result.health, {
    chat:{ok:false,label:"HTTP 503"}, decider:{ok:true,label:"Servidor respondeu"},
  });
});

test("o controle e a seleção automática usam o Revisor dedicado e voltam ao principal quando ausente", async t => {
  const id = "m_0011223344556677";
  const primary = {port: 8080, model: "principal-manual"};
  const servers = {chat: {model_id: id, port: 8100, api_model: "principal"}, decider: null,
    reviewer: {model_id: id, port: 8083, api_model: "modelo-revisor"}};
  const requests = [];
  let models = [{id: "modelo-revisor"}];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({url, body: options.body});
    if (url.endsWith("/health")) return new Response(null, {status: 200});
    if (url.endsWith("/v1/models")) return Response.json({data: models});
    return Response.json({version: 1, models: [{id, name: "GGUF", role: "chat"}], servers});
  });
  const connection = {token: "ficticio"};
  await launcher.control("start", {...connection, role: "reviewer", model_id: id});
  assert.deepEqual(JSON.parse(requests[0].body), {role: "reviewer", model_id: id});
  assert.equal((await launcher.watchLauncher(connection)).health.reviewer.ok, true);
  assert.deepEqual(await launcher.reviewerChat(primary, connection), {port: 8083, model: "modelo-revisor", source: "dedicated"});
  servers.reviewer = null;
  assert.deepEqual(await launcher.reviewerChat(primary, connection), {port: 8100, model: "principal", source: "primary"});
  assert.equal(requests.some(item => item.url.endsWith("/v1/models")), false);
  delete servers.reviewer;
  assert.deepEqual(await launcher.reviewerChat(primary, connection), {port: 8081, model: "modelo-revisor", source: "dedicated"});
  models = [{id: "outro-servico"}];
  assert.deepEqual(await launcher.reviewerChat(primary), {...primary, source: "primary"});
});
