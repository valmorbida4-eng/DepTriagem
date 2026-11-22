const assert = require("node:assert/strict");
const {test} = require("node:test");
const {mkdtemp, writeFile, mkdir, rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const system = require("../../build/electron/system");
const {modelGuidance, modelPlan, setCredential, credentialStatus, testModel, listModels, triageWithModel} = require("../../build/electron/models");

test("pares de provedores independentes, consentimento e inventário local", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const input = JSON.parse(request.body);
    calls.push({url: String(url), input});
    const content = JSON.stringify({checks: [calls.length === 1 ? "review_lockfiles" : "review_catalog_coverage"]});
    if (String(url).startsWith("https://api.openai.com")) {
      return Response.json({output: [{type: "message", content: [{type: "output_text", text: content}]}]});
    }
    if (String(url).startsWith("https://generativelanguage")) {
      return Response.json({candidates: [{content: {parts: [{text: content}]}}]});
    }
    return Response.json({choices: [{message: {content}}]});
  });
  const evidence = {languages: {TypeScript: 5}, coverage_issues: ["no_packages_scanned"], findings_count: 0};
  const inventory = {packages: [{name: "internal-package", version: "1.2.3"}]};
  const keys = {openai: "fake-openai", gemini: "fake-gemini", opencode: "fake-zen"};
  for (const [agent, reviewer] of [
    ["launcher", "launcher"], ["launcher", "gemini"], ["openai", "opencode"], ["gemini", "gemini"],
  ]) {
    calls.length = 0;
    const plan = modelPlan({agent: {provider: agent, model: "example-a", port: 8081},
      reviewer: {provider: reviewer, model: "example-b", port: 8082}});
    const result = await modelGuidance(evidence, plan, true, keys, undefined, inventory);
    assert.deepEqual(result.roles.map(item => [item.provider, item.status]), [[agent, "suggestions"], [reviewer, "suggestions"]]);
    assert.equal(result.checks.length, 2);
    assert.match(JSON.stringify(calls[1].input), /previous_checks.*review_lockfiles/);
    for (const call of calls) {
      assert.equal(JSON.stringify(call.input).includes("internal-package"), call.url.startsWith("http://127.0.0.1"));
    }
  }
  calls.length = 0;
  const denied = await modelGuidance(evidence, modelPlan({agent: {provider: "gemini"}, reviewer: {provider: "launcher"}}),
    false, keys, undefined, inventory);
  assert.equal(calls.length, 1);
  assert.deepEqual(denied.roles.map(item => item.status), ["external_not_authorized", "suggestions"]);
});

test("valida escolhas e mantém chaves de sessão fora do status", () => {
  const credentials = {};
  assert.throws(() => modelPlan({reviewer: {provider: "other"}}));
  assert.throws(() => modelPlan({reviewer: {provider: "codex", model: "--bad"}}));
  assert.throws(() => modelPlan({agent: {provider: "opencode", effort: "high"}}));
  setCredential(credentials, "gemini", "fake-test-key");
  assert.equal(credentialStatus(credentials).gemini, true);
  assert.doesNotMatch(JSON.stringify(credentialStatus(credentials)), /fake-test-key/);
  setCredential(credentials, "gemini", "");
  assert.equal(credentials.gemini, undefined);
});

test("envia o esforço no formato de cada API", async t => {
  const requests = [];
  const content = JSON.stringify({checks: ["review_lockfiles"]});
  t.mock.method(globalThis, "fetch", async (url, request) => {
    requests.push(JSON.parse(request.body));
    return String(url).startsWith("https://api.openai.com")
      ? Response.json({output: [{type: "message", content: [{type: "output_text", text: content}]}]})
      : Response.json({candidates: [{content: {parts: [{text: content}]}}]});
  });
  const keys = {openai: "fake-openai", gemini: "fake-gemini"};
  for (const model of [
    {provider: "openai", model: "gpt-example", effort: "high"},
    {provider: "gemini", model: "gemini-3-flash", effort: "low"},
    {provider: "gemini", model: "gemini-2.5-pro", effort: "medium"},
  ]) assert.equal((await testModel(model, keys)).status, "connected");
  assert.deepEqual(requests[0].reasoning, {effort: "high"});
  assert.deepEqual(requests[1].generationConfig.thinkingConfig, {thinkingLevel: "LOW"});
  assert.deepEqual(requests[2].generationConfig.thinkingConfig, {thinkingBudget: 4096});
});

test("a busca normaliza IDs e usa a capacidade informada no catálogo da Anthropic", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({url, options});
    if (String(url).includes("after_id=")) return Response.json({data: [{id: "--invalid"}], has_more: false});
    return Response.json({data: [{id: "claude-example", display_name: "Claude Example",
      capabilities: {effort: {low: {supported: true}, medium: {supported: false}, high: {supported: true}}}}],
      has_more: true, last_id: "claude-example"});
  });
  assert.deepEqual(await listModels("claude", {claude: "fake-claude"}), {source: "Catálogo da API Anthropic",
    models: [{id: "claude-example", label: "Claude Example", efforts: ["low", "high"]}]});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers["x-api-key"], "fake-claude");
  assert.match(calls[1].url, /after_id=claude-example/);
  assert.ok(calls.every(item => item.options.body === undefined));
});

test("a busca do agy usa a chave da sessão e filtra modelos Gemini de geração", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?/);
    assert.equal(options.headers["x-goog-api-key"], "fake-agy");
    return Response.json({models: [
      {name: "models/gemini-example", displayName: "Gemini Example", supportedGenerationMethods: ["generateContent"]},
      {name: "models/gemini-example-embeddings", supportedGenerationMethods: ["embedContent"]},
      {name: "models/other", supportedGenerationMethods: ["generateContent"]},
    ]});
  });
  const result = await listModels("agy", {agy: "fake-agy"});
  assert.deepEqual(result.models.map(model => model.id), ["gemini-example"]);
});

test("a busca usa Claude Code e Antigravity CLI sem chaves de API", async t => {
  const environment = new Map();
  for (const key of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
    environment.set(key, process.env[key]);
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of environment) {
      if (value !== undefined) process.env[key] = value;
    }
  });
  const calls = [];
  t.mock.method(system, "run", async (program, args, options) => {
    calls.push({program, args, options});
    if (args[0] === "models") return {code: 0, diagnostics: "Fetching available models...",
      output: Buffer.from("gemini-example\tGemini Example\r\ngemini-example-2  Gemini Example 2\r\n")};
    const request = JSON.parse(options.input);
    return {code: 0, diagnostics: "", output: Buffer.from(JSON.stringify({type: "control_response",
      response: {subtype: "success", request_id: request.request_id, response: {
        models: [{value: "sonnet", displayName: "Sonnet", supportedEffortLevels: ["low", "high"]}],
      }},
    }))};
  });
  const claude = await listModels("claude");
  assert.deepEqual(claude, {source: "Claude Code CLI", models: [{id: "sonnet", label: "Sonnet", efforts: ["low", "high"]}]});
  assert.equal(JSON.parse(calls[0].options.input).request.subtype, "initialize");
  assert.equal(calls[0].args[calls[0].args.indexOf("--tools") + 1], "");
  const agy = await listModels("agy");
  assert.deepEqual(agy.models.map(model => model.id), ["gemini-example", "gemini-example-2"]);
  assert.equal(calls[1].options.cwd, tmpdir());
  assert.equal(calls[1].options.input, undefined);
});

test("usa a configuração de modelo no Decisor e exige autorização para o relato externo", async t => {
  const decision = {choice: "functional_bug", probabilities: {functional_bug: .92, security: .03, needs_review: .05}};
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, request) => {
    calls.push({url, payload: JSON.parse(request.body)});
    return Response.json({output: [{type: "message", content: [{type: "output_text", text: JSON.stringify(decision)}]}]});
  });
  const config = {mode: "openai", model: "modelo-ficticio", effort: "low"};
  const denied = await triageWithModel("Relato fictício", config);
  assert.deepEqual(denied, {queue: "needs_review", reason: "external_not_authorized"});
  assert.equal(calls.length, 0);
  const result = await triageWithModel("Relato fictício", config, undefined, undefined, true, {openai: "fake-key"});
  assert.equal(result.queue, "functional_bug");
  assert.deepEqual(calls[0].payload.reasoning, {effort: "low"});
  assert.equal(calls[0].payload.text.format.name, "deptriagem_routing");
  assert.match(calls[0].payload.input, /Relato fictício/);
});

test("o Decisor OpenCode local registra somente o servidor loopback escolhido", async t => {
  const runs = [];
  t.mock.method(system, "run", async (_program, args, options) => {
    runs.push({args, options});
    const text = JSON.stringify({choice: "functional_bug", probabilities: {functional_bug: .91, security: .04, needs_review: .05}});
    return {code: 0, diagnostics: "", output: Buffer.from(args[0] === "--version" ? "1.19.5"
      : JSON.stringify({type: "text", part: {text}}))};
  });
  const result = await triageWithModel("Relato fictício", {mode: "opencode-local", port: 8077, model: "kev-fixture"});
  assert.equal(result.queue, "functional_bug");
  const {args, options} = runs[1];
  assert.equal(args[args.indexOf("--model") + 1], "deptriagem-local/kev-fixture");
  const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider["deptriagem-local"].options.baseURL, "http://127.0.0.1:8077/v1");
  assert.deepEqual(config.enabled_providers, ["deptriagem-local"]);
  assert.deepEqual(config.permission, {"*": "deny"});
});

test("o catálogo OpenCode inclui conexões por chave e mantém provedores após os primeiros 500 modelos", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "deptriagem-opencode-catalog-test-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = fixture;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    await rm(fixture, {recursive: true, force: true});
  });
  await mkdir(join(fixture, "opencode"));
  await writeFile(join(fixture, "opencode", "auth.json"), JSON.stringify({
    openrouter: {type: "api", key: "fake-openrouter"}, custom: {type: "api", key: "fake-custom"},
  }));
  let connections;
  t.mock.method(system, "run", async (_program, args, options) => {
    if (args[0] === "--version") return {code: 0, output: Buffer.from("1.19.5"), diagnostics: ""};
    connections = Object.keys(JSON.parse(options.env.OPENCODE_AUTH_CONTENT));
    const output = [...Array.from({length: 510}, (_, index) => "openrouter/example-" + index),
      "groq/example", "zenmux/example", "openrouter/~example/latest", "custom/example", "unknown/example"].join("\n");
    return {code: 0, output: Buffer.from(output), diagnostics: ""};
  });
  const result = await listModels("opencode-cli");
  assert.deepEqual(connections.sort(), ["custom", "openrouter"]);
  assert.equal(result.models.length, 514);
  assert.deepEqual(result.models.slice(-4).map(item => item.id),
    ["groq/example", "zenmux/example", "openrouter/~example/latest", "custom/example"]);
});

test("o Decisor relata login expirado do Claude sem expor a saída do processo", async t => {
  const prior = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (prior !== undefined) process.env.ANTHROPIC_API_KEY = prior; });
  let cliArgs;
  t.mock.method(system, "run", async (_program, args) => {
    cliArgs = args;
    return {code: 1, diagnostics: "", output: Buffer.from(JSON.stringify({
      result: "Failed to authenticate: OAuth session expired and could not be refreshed. fixture-secret",
    }))};
  });
  const result = await triageWithModel("Relato fictício", {mode: "claude", model: "haiku"}, undefined, undefined, true);
  assert.equal(result.reason, "decider_unavailable");
  assert.match(result.detail, /Claude Code.*expirada/);
  assert.doesNotMatch(result.detail, /fixture-secret/);
  assert.equal(cliArgs.includes("--bare"), false);
  assert.equal(cliArgs[cliArgs.indexOf("--tools") + 1], "");
});

test("OpenCode CLI e Antigravity CLI usam sessões isoladas e parâmetros de esforço", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "deptriagem-cli-test-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = fixture;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    await rm(fixture, {recursive: true, force: true});
  });
  await mkdir(join(fixture, "opencode"));
  await writeFile(join(fixture, "opencode", "auth.json"), JSON.stringify({
    openai: {type: "api", key: "fake-openai"}, anthropic: {type: "api", key: "fake-anthropic"},
  }));
  const runs = [];
  const checks = {checks: ["review_lockfiles"]};
  t.mock.method(system, "run", async (program, args, options) => {
    runs.push({program, args, options});
    if (args[0] === "run") {
      const attachment = args[args.indexOf("--file") + 1];
      assert.match(await require("node:fs/promises").readFile(attachment, "utf8"), /previous_checks/);
      assert.equal(args.some(value => value.includes("previous_checks")), false);
    }
    const output = args.includes("--version") ? "1.19.5\n" : args[0] === "run"
      ? JSON.stringify({type: "text", part: {text: JSON.stringify(checks)}})
      : JSON.stringify({event: "result", result: {status: "SUCCESS", response: JSON.stringify(checks)}});
    return {code: 0, output: Buffer.from(output), diagnostics: ""};
  });
  assert.equal((await testModel({provider: "opencode-cli", model: "openai/example", effort: "high"})).status, "connected");
  assert.equal((await testModel({provider: "agy", model: "gemini-example", effort: "medium"}, {agy: "fake-agy"})).status, "connected");
  const [, openCode, agy] = runs;
  assert.deepEqual(JSON.parse(openCode.options.env.OPENCODE_AUTH_CONTENT), {openai: {type: "api", key: "fake-openai"}});
  assert.deepEqual(JSON.parse(openCode.options.env.OPENCODE_PERMISSION), {"*": "deny"});
  assert.equal(openCode.options.env.HOME, openCode.options.cwd);
  assert.equal(openCode.args[openCode.args.indexOf("--variant") + 1], "high");
  const settings = JSON.parse(agy.args[agy.args.indexOf("--settings") + 1]);
  assert.equal(settings.agentMode, "plan");
  assert.equal(settings.toolPermission, "strict");
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.ok(settings.permissions.deny.includes("command(*)"));
  assert.equal(agy.args[agy.args.indexOf("--model") + 1], "gemini-example");
  assert.equal(agy.args[agy.args.indexOf("--effort") + 1], "medium");
  assert.equal(agy.options.env.GEMINI_API_KEY, "fake-agy");
  assert.equal(agy.args[agy.args.indexOf("--input-format") + 1], "stream-json");
  assert.match(JSON.parse(agy.options.input).message.content, /previous_checks/);
  assert.equal(agy.args.some(value => value.includes("previous_checks")), false);
});
