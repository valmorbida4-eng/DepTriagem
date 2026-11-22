const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const {mkdtempSync, rmSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join, resolve} = require("node:path");
const {test} = require("node:test");
const {mcpTarget, testMcp} = require("../../build/electron/mcp");

const cli = resolve(__dirname, "../../build/electron/cli.js");
const request = (id, method, params) => ({jsonrpc: "2.0", id, method, params});
const init = request(1, "initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "test", version: "1"}});
const ready = request(undefined, "notifications/initialized");

function run(t, args, messages) {
  const profile = mkdtempSync(join(tmpdir(), "deptriagem-mcp-test-"));
  t.after(() => rmSync(profile, {force: true, recursive: true}));
  const result = spawnSync(process.execPath, [cli, "mcp", ...args], {
    env: {...process.env, DEPTRIAGEM_DATA_DIR: profile}, encoding: "utf8", timeout: 15_000,
    input: messages && messages.map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\r\n") + "\r\n",
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("MCP stdio negocia versão e responde apenas com mensagens JSON-RPC", t => {
  const messages = [request(0, "tools/list"), init, ready, "{", request(2, "ping"), request(3, "tools/list"),
    request(4, "tools/call", {name: "catalog_status", arguments: {}}),
    request(5, "tools/call", {name: "analyze_dependencies"}), request(6, "unknown")];
  const output = run(t, ["serve"], messages).trim().split("\n").map(JSON.parse);
  assert.equal(output.length, 8);
  assert.ok(output.every(message => message.jsonrpc === "2.0"));
  const response = id => output.find(item => item.id === id);
  assert.equal(response(0).error.code, -32002);
  assert.equal(response(1).result.protocolVersion, "2025-06-18");
  assert.equal(response(null).error.code, -32700);
  assert.deepEqual(response(2).result, {});
  assert.deepEqual(response(3).result.tools.map(item => item.name), ["catalog_status"]);
  assert.deepEqual(Object.keys(JSON.parse(response(4).result.content[0].text)), ["npm", "PyPI", "NuGet", "KEV"]);
  assert.equal(response(5).error.code, -32602);
  assert.equal(response(6).error.code, -32601);
});

test("MCP só aceita o projeto configurado no início da sessão", t => {
  const messages = [init, ready, request(2, "tools/list"),
    request(3, "tools/call", {name: "analyze_dependencies", arguments: {path: ".."}})];
  const output = run(t, ["serve", "--root", __dirname], messages).trim().split("\n").map(JSON.parse);
  assert.deepEqual(output.find(item => item.id === 2).result.tools.map(item => item.name), ["catalog_status", "analyze_dependencies"]);
  assert.equal(output.find(item => item.id === 3).error.code, -32602);
});

test("gera configurações locais dos clientes MCP", t => {
  for (const host of ["claude", "gemini", "antigravity", "vscode", "opencode", "opencode-v1"]) {
    const config = JSON.parse(run(t, ["config", host, "--github", "example/project", "--ref", "main"]));
    const tool = config.mcpServers?.deptriagem ?? config.servers?.deptriagem ?? config.mcp?.servers?.deptriagem ?? config.mcp?.deptriagem;
    const args = tool.args ?? tool.command.slice(1);
    assert.deepEqual(args.slice(1), ["mcp", "serve", "--github", "example/project", "--ref", "main"]);
    assert.equal(args[0], cli);
  }
  assert.match(run(t, ["config", "codex"]), /^\[mcp_servers.deptriagem\]/);
});

test("o teste local negocia o MCP e confirma somente as ferramentas do acesso selecionado", async t => {
  const profile = mkdtempSync(join(tmpdir(), "deptriagem-mcp-negotiation-"));
  const previous = process.env.DEPTRIAGEM_DATA_DIR;
  process.env.DEPTRIAGEM_DATA_DIR = profile;
  t.after(() => {
    if (previous === undefined) delete process.env.DEPTRIAGEM_DATA_DIR;
    else process.env.DEPTRIAGEM_DATA_DIR = previous;
    rmSync(profile, {force: true, recursive: true});
  });
  for (const target of [undefined, await mcpTarget(__dirname), await mcpTarget(undefined, "example/project", "main")]) {
    const progress = [];
    const result = await testMcp(target, step => progress.push([step.completed, step.total]));
    assert.equal(result.protocolVersion, "2025-11-25");
    assert.deepEqual(result.tools, target ? ["catalog_status", "analyze_dependencies"] : ["catalog_status"]);
    assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  }
});
