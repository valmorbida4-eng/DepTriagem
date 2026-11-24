const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {app, BrowserWindow, clipboard, dialog, ipcMain} = require("electron");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deptriagem-smoke-"));
process.env.DEPTRIAGEM_DATA_DIR = directory;
process.env.GH_CONFIG_DIR = path.join(directory, "gh");
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({update_check: false, theme: "dark", models: {
  agent: {provider: "codex", model: "example-codex", effort: "high"},
  reviewer: {provider: "gemini", model: "example-gemini", effort: "low"},
}, triage_decider: {mode: "codex", model: "example-decider", effort: "low"}}));
require("../build/electron/main.js");
(async () => {
  try {
    const deadline = Date.now() + 20_000;
    let window;
    while (Date.now() < deadline) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading() &&
        await window.webContents.executeJavaScript("Boolean(document.querySelector('#version')?.textContent)")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(window);
    const actual = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-group=settings]').click();
      document.querySelector('[data-page=updates]').click();
      const visible = !document.querySelector('#page-updates').hidden;
      document.querySelector('[data-page=models]').click();
      const models = !document.querySelector('#page-models').hidden;
      const controls = [...document.querySelectorAll('#model-roles [data-field=provider]')];
      document.querySelector('[data-group=analysis]').click();
      return {visible, models, providers: controls[0].options.length,
        consent: !document.querySelector('#external-consent').hidden && !document.querySelector('#allow-external').checked,
        theme: document.documentElement.dataset.theme, require: typeof window.require,
        analyzed: !document.querySelector('#page-projects').hidden, version: document.querySelector('#version').textContent};
    })()`);
    assert.deepEqual(actual, {visible: true, models: true, providers: 9, consent: true,
      theme: "dark", require: "undefined", analyzed: true, version: "· v" + require("../package.json").version});
    assert.equal(await window.webContents.executeJavaScript("window.deptriagem.invoke('system:exec').then(() => false, () => true)"), true);
    ipcMain.removeHandler("project:analyze");
    let call;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    ipcMain.handle("project:analyze", async (event, input) => {
      call = {sender: event.sender, id: input.progressId, input};
      await done;
      return {ok: true, data: {schema_version: 1, source: {directory: "fixture"}, packages_reported: 1,
        coverage: "inventory_scanned", coverage_issues: [], kev_status: "missing", findings: [{
          name: "pacote-ficticio", version: "1.0", ecosystem: "npm", source: "package-lock.json", ids: ["GHSA-fixture"],
          priority: "manual_review", severity: "high", cvss: 8.1, fixed_versions: ["2.0.0"], advisories: [],
        }], model_guidance: input.automaticReviewer && {status: "suggestions",
          reviewer_launcher: {source: "primary", model: "principal-ficticio", port: 8080},
          roles: [{role: "reviewer", provider: "launcher", status: "suggestions"}]},
        model_decision: input.decider && {queue: "priority_review", reason: "model_suggestion"}}};
    });
    const execute = script => window.webContents.executeJavaScript(script);
    const githubBadges = () => execute(`["source-account", "github-account", "mcp-account"].map(id => {
      const badge = document.getElementById(id);
      return [badge.dataset.state, badge.textContent, getComputedStyle(badge).backgroundColor];
    })`);
    async function expectGithubBadge(state, text, color) {
      const expected = Array.from({length: 3}, () => [state, text, color]);
      for (let attempt = 0; attempt < 100; attempt++) {
        const badges = await githubBadges();
        if (JSON.stringify(badges) === JSON.stringify(expected)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.deepEqual(await githubBadges(), expected);
    }
    await expectGithubBadge("disconnected", "Conta não conectada", "rgb(14, 25, 30)");
    ipcMain.removeHandler("github:configured");
    ipcMain.handle("github:configured", () => ({ok: true, data: true}));
    ipcMain.removeHandler("github:account");
    let githubAvailable = false;
    ipcMain.handle("github:account", () => githubAvailable ? {ok: true, data: "conta-ficticia"}
      : {ok: false, message: "GitHub indisponível."});
    await execute(`document.querySelector('#github-check').click();`);
    await expectGithubBadge("unverified", "Conta ainda não verificada", "rgb(70, 55, 25)");
    for (let attempt = 0; attempt < 100 && await execute("document.querySelector('#github-check').disabled"); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    githubAvailable = true;
    await execute(`document.querySelector('#github-check').click();`);
    await expectGithubBadge("verified", "GitHub · conta-ficticia", "rgb(33, 57, 47)");
    const picks = await execute(`(() => {
      const selection = document.querySelector('#project-agent-provider');
      const reviewSelection = document.querySelector('#project-reviewer-provider');
      function choose(control, value) {
        control.value = value;
        control.dispatchEvent(new Event('change'));
      }
      choose(selection, 'launcher');
      if (!document.querySelector('#project-agent-model-help').textContent.includes('modelo-local')) throw Error('Launcher ausente');
      choose(selection, 'agent');
      document.querySelector('#allow-external').checked = true;
      choose(reviewSelection, 'launcher');
      choose(reviewSelection, 'reviewer');
      const decider = document.querySelector('#project-decider-selection');
      choose(decider, 'launcher');
      if (!document.querySelector('#project-decider-model-help').textContent.includes('8090')) throw Error('Decisor do Launcher ausente');
      choose(decider, 'configured');
      return {
        providerCount: selection.options.length,
        agent: document.querySelector('#model-roles select').value,
        reviewer: reviewSelection.value,
        model: document.querySelector('#project-reviewer-model-help').textContent,
        consentVisible: !document.querySelector('#external-consent').hidden,
        approved: document.querySelector('#allow-external').checked,
        decider: document.querySelector('#project-decider-model-help').textContent,
      };
    })()`);
    assert.deepEqual(picks, {providerCount: 4, agent: "codex", reviewer: "reviewer", model: "example-gemini · Baixo",
      consentVisible: true, approved: false, decider: "Codex CLI · example-decider · Baixo"});
    await execute(`document.querySelector('#project-commit').value = 'HEAD^';
      document.querySelector('#allow-external').checked = true;
      document.querySelector('#analyze').click();`);
    for (let index = 0; !call && index < 40; index++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(call?.id);
    assert.equal(call.input.models.agent.provider, "codex");
    assert.equal(call.input.models.agent.effort, "high");
    assert.deepEqual(call.input.models.reviewer, {provider: "gemini", model: "example-gemini", effort: "low"});
    assert.deepEqual(call.input.decider, {mode: "codex", model: "example-decider", effort: "low"});
    assert.equal(call.input.allowExternal, true);
    assert.equal(call.input.commit, "HEAD^");
    assert.equal(await execute("document.querySelector('#allow-external').checked"), false);
    assert.equal(await execute("document.querySelector('#operations progress').hasAttribute('value')"), false);
    call.sender.send("operation:progress", call.id, {label: "Inventario", completed: 2, total: 5, unit: "steps"});
    const currentProgress = () => execute(`(() => {
      const bar = document.querySelector('#operations progress');
      return {completed: bar.value, total: bar.max};
    })()`);
    for (let index = 0; index < 80; index++) {
      if ((await currentProgress()).completed === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(await currentProgress(), {completed: 2, total: 5});
    finish();
    for (let index = 0; index < 40; index++) {
      if (await execute("document.querySelector('#operations').hidden")) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await execute("document.querySelector('#operations').hidden"), true);
    assert.ok(await execute("document.querySelector('#project-decision-result').textContent.includes('Decisor · Priorizar revisão')"));
    assert.ok(await execute("document.querySelector('#project-result').textContent.includes('CVSS base 8.1')"));
    const reports = path.join(directory, "custom reports");
    fs.mkdirSync(reports);
    const waitFor = async (script, attempts = 80) => {
      for (let index = 0; index < attempts; index++) {
        if (await execute(script)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail("Timed out: " + script);
    };
    let listedProvider;
    ipcMain.removeHandler("model:list");
    ipcMain.handle("model:list", (_event, input) => {
      listedProvider = input.provider;
      return {ok: true, data: {source: "Catálogo de teste", models: [
        {id: "codex-exemplo", label: "Codex Exemplo", efforts: ["low", "high"]},
        {id: "codex-outro", label: "Outro modelo", efforts: ["medium"]},
      ]}};
    });
    await execute(`document.querySelector('[data-group=settings]').click();
      document.querySelector('[data-page=models]').click();
      document.querySelector('#model-roles [data-field=search]').click();`);
    await waitFor("document.querySelector('#model-picker-list').options.length === 2");
    assert.equal(listedProvider, "codex");
    await execute(`const filter = document.querySelector('#model-picker-filter');
      filter.value = 'exemplo';
      filter.dispatchEvent(new Event('input'));
      document.querySelector('#model-picker-use').click();`);
    assert.deepEqual(await execute("[...document.querySelector('#model-roles [data-field=effort]').options].map(option => option.value)"),
      ["", "low", "high"]);
    assert.equal(await execute("document.querySelector('#model-roles [data-field=model]').value"), "codex-exemplo");
    assert.equal(await execute("document.querySelector('#model-roles [data-field=search]').hidden"), false);
    await execute("document.querySelector('[data-page=projects]').click()");
    let testedModel;
    ipcMain.removeHandler("model:test");
    ipcMain.handle("model:test", (_event, input) => {
      testedModel = input.model;
      return {ok: true, data: {status: "missing_credential"}};
    });
    await execute("document.querySelector('#project-agent-test').click()");
    await waitFor("document.querySelector('#project-agent-test-status').dataset.error === 'true'");
    assert.equal(testedModel.provider, "codex");
    assert.equal(testedModel.effort, "high");
    assert.equal(testedModel.model, "example-codex");
    await execute("document.querySelector('#project-reviewer-test').click()");
    await waitFor("document.querySelector('#project-reviewer-test-status').dataset.error === 'true'");
    assert.equal(testedModel.model, "example-gemini");

    let triageTest;
    ipcMain.removeHandler("triage:test");
    ipcMain.handle("triage:test", (_event, input) => {
      triageTest = input;
      return {ok: true, data: {ok: false}};
    });
    await execute("document.querySelector('#project-decider-test').click()");
    await waitFor("document.querySelector('#project-decider-test-status').dataset.error === 'true'");
    assert.equal(triageTest.analysis, true);
    assert.equal(triageTest.decider.model, "example-decider");
    await execute(`document.querySelector('[data-page=triage]').click();
      document.querySelector('#open-decider-settings').click();
      const mode = document.querySelector('#triage-decider-mode');
      mode.value = 'chat';
      mode.dispatchEvent(new Event('change'));
      document.querySelector('#triage-chat-port').value = '8077';
      document.querySelector('#triage-chat-model').value = 'teste-local';
      document.querySelector('#test-triage-decider').click();`);
    await waitFor("document.querySelector('#triage-decider-status').dataset.error === 'true'");
    assert.deepEqual(triageTest.decider, {mode: "chat", port: 8077, model: "teste-local"});
    assert.equal(triageTest.report, undefined);
    await execute("document.querySelector('#save-triage-decider').click()");
    await waitFor("document.querySelector('#triage-decider-status').textContent.includes('salva')");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")).triage_decider,
      {mode: "chat", port: 8077, model: "teste-local"});
    await execute("document.querySelector('[data-page=triage]').click()");
    assert.equal(await execute("document.querySelector('#triage-decider-selection').value"), "configured");
    assert.ok(await execute("document.querySelector('#triage-decider-selection-help').textContent.includes('teste-local')"));
    assert.equal(await execute("document.querySelector('#page-triage #triage-decider-mode')"), null);
    ipcMain.removeHandler("triage:models");
    ipcMain.handle("triage:models", (_event, input) => ({ok: true, data: {source: input.decider.mode, models: [
      {id: "luna-ficticio", label: "Luna de teste", efforts: ["low", "high"]},
    ]}}));
    await execute(`document.querySelector('#open-decider-settings').click();
      const codexMode = document.querySelector('#triage-decider-mode');
      codexMode.value = 'codex';
      codexMode.dispatchEvent(new Event('change'));
      document.querySelector('#triage-opencode-search').click();`);
    await waitFor("document.querySelector('#model-picker-list').options.length === 1");
    await execute(`document.querySelector('#model-picker-use').click();
      document.querySelector('#triage-model-effort').value = 'high';
      document.querySelector('#save-triage-decider').click();`);
    await waitFor("document.querySelector('#triage-decider-status').textContent.includes('salva')");
    let triageRun;
    ipcMain.removeHandler("triage:run");
    ipcMain.handle("triage:run", (_event, input) => {
      triageRun = input;
      return {ok: true, data: {queue: "needs_review", reason: "uncertain"}};
    });
    await execute(`document.querySelector('[data-page=triage]').click();
      document.querySelector('#triage-allow-external').checked = true;
      document.querySelector('#triage').click();`);
    await waitFor("document.querySelector('#triage-result').textContent.includes('Revisão humana')");
    assert.deepEqual(JSON.parse(JSON.stringify(triageRun.decider)), {mode: "codex", model: "luna-ficticio", effort: "high"});
    assert.equal(triageRun.allowExternal, true);
    assert.equal(await execute("document.querySelector('#triage-allow-external').checked"), false);
    ipcMain.removeHandler("triage:models");
    ipcMain.handle("triage:models", () => ({ok: true, data: {source: "OpenCode CLI", models: [
      {id: "openrouter/exemplo", label: "Exemplo OpenRouter"}, {id: "groq/exemplo", label: "Exemplo Groq"},
    ]}}));
    await execute(`document.querySelector('#open-decider-settings').click();
      const opencodeMode = document.querySelector('#triage-decider-mode');
      opencodeMode.value = 'opencode';
      opencodeMode.dispatchEvent(new Event('change'));
      document.querySelector('#triage-opencode-search').click();`);
    await waitFor("!document.querySelector('#model-picker-provider-field').hidden");
    await execute(`const prov = document.querySelector('#model-picker-provider');
      prov.value = 'groq';
      prov.dispatchEvent(new Event('change'));`);
    assert.deepEqual(await execute("[...document.querySelector('#model-picker-list').options].map(option => option.value)"), ["groq/exemplo"]);
    await execute("document.querySelector('#model-picker-close').click()");
    await execute("document.querySelector('[data-page=projects]').click()");

    await execute(`document.querySelector('#project-folder').value = ${JSON.stringify(reports)};
      document.querySelector('#project-to-mcp').click();`);
    await waitFor("!document.querySelector('#page-mcp').hidden");
    assert.equal(await execute("document.querySelector('#mcp-folder').value"), reports);
    await execute("document.querySelector('#mcp-preview').click()");
    await waitFor("!document.querySelector('#mcp-snippet').hidden");
    const snippet = await execute("document.querySelector('#mcp-snippet').textContent");
    assert.match(snippet, /mcp_servers\.deptriagem/);
    const mcpArgs = JSON.parse(snippet.match(/^args = (.+)$/m)[1]);
    assert.equal(mcpArgs[mcpArgs.indexOf("--root") + 1], await fs.promises.realpath(reports));
    assert.equal(mcpArgs[mcpArgs.indexOf("--commit") + 1], "HEAD^");
    let copiedConfig;
    clipboard.writeText = text => { copiedConfig = text; };
    await execute("document.querySelector('#mcp-copy').click()");
    await waitFor("document.querySelector('#mcp-config-status').textContent === 'Configuração copiada.'");
    assert.equal(copiedConfig, snippet);
    await execute("document.querySelector('#mcp-test').click()");
    await waitFor("document.querySelector('#mcp-test-status').textContent.includes('analyze_dependencies')", 480);
    await execute(`const source = document.querySelector('#mcp-kind');
      source.value = 'catalogs';
      source.dispatchEvent(new Event('change'));
      document.querySelector('#mcp-test').click();`);
    await waitFor("document.querySelector('#mcp-test-status').textContent.includes('catalog_status')", 480);
    assert.equal(await execute("document.querySelector('#mcp-test-status').textContent.includes('analyze_dependencies')"), false);
    await execute(`const client = document.querySelector('#mcp-client');
      client.value = 'vscode';
      client.dispatchEvent(new Event('change'));
      document.querySelector('#mcp-check-client').click();`);
    await waitFor("document.querySelector('#mcp-client-status').textContent.includes('Aguardando a primeira')");
    await execute("document.querySelector('#mcp-preview').click()");
    await waitFor("!document.querySelector('#mcp-snippet').hidden");
    const config = JSON.parse(await execute("document.querySelector('#mcp-snippet').textContent")).servers.deptriagem;
    const client = spawnSync(config.command, config.args, {
      env: {...process.env, ...config.env}, windowsHide: true, encoding: "utf8", timeout: 12_000,
      input: [
        {jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-11-25", capabilities: {},
          clientInfo: {name: "test-client", version: "1"}}},
        {jsonrpc: "2.0", method: "notifications/initialized"},
      ].map(message => JSON.stringify(message) + "\n").join(""),
    });
    assert.equal(client.status, 0, client.error?.message || client.stderr);
    await execute("document.querySelector('#mcp-check-client').click()");
    await waitFor("document.querySelector('#mcp-client-status').textContent.includes('Última conexão confirmada')");

    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [reports]});
    let defaultPath;
    dialog.showSaveDialog = async (_window, options) => {
      defaultPath = options.defaultPath;
      return {canceled: false, filePath: defaultPath};
    };
    await execute("document.querySelector('[data-group=analysis]').click()");
    const themeButtonState = () => execute(`(() => {
      const button = document.querySelector('.app-header #theme-toggle');
      return [button.querySelector('#theme-label').textContent, button.getClientRects().length > 0];
    })()`);
    assert.deepEqual(await themeButtonState(), ["Escuro", true]);
    await execute("document.querySelector('#theme-toggle').click()");
    assert.deepEqual(await themeButtonState(), ["Sistema", true]);
    await execute("document.querySelector('#theme-toggle').click()");
    assert.deepEqual(await themeButtonState(), ["Claro", true]);
    await execute("document.querySelector('#theme-toggle').click()");
    assert.deepEqual(await themeButtonState(), ["Escuro", true]);
    await execute(`document.querySelector('#theme-toggle').click();
      document.querySelector('#theme-toggle').click();
      document.querySelector('[data-group=settings]').click();
      document.querySelector('[data-page=preferences]').click();
      document.querySelector('[data-target=reports-path]').click();`);
    await waitFor("Boolean(document.querySelector('#reports-path').value)");
    assert.equal(await execute("document.documentElement.dataset.theme"), "light");
    assert.equal(await execute("document.querySelector('#reports-path').value"), reports);
    await execute("document.querySelector('#save-preferences').click()");
    await waitFor("!document.querySelector('#save-preferences').disabled");
    await execute("document.querySelector('[data-group=analysis]').click(); document.querySelector('#save-project').click()");
    await waitFor("!document.querySelector('#save-project').disabled");
    assert.equal(defaultPath, path.join(reports, "deptriagem-relatorio.json"));
    assert.equal(JSON.parse(fs.readFileSync(defaultPath, "utf8")).packages_reported, 1);
    const preferences = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"));
    assert.equal(preferences.reports_dir, reports);
    assert.equal(preferences.theme, "light");
    await execute("document.querySelector('#export-project').click()");
    await waitFor("!document.querySelector('#export-project').disabled");
    const bundle = JSON.parse(fs.readFileSync(path.join(defaultPath, "parecer-ia.json"), "utf8"));
    const official = fs.readFileSync(path.join(defaultPath, "relatorio.json"));
    assert.equal(bundle.report_sha256, createHash("sha256").update(official).digest("hex"));
    assert.equal(JSON.parse(official).model_decision, undefined);
    assert.match(fs.readFileSync(path.join(defaultPath, "relatorio.md"), "utf8"), /pacote/);
    await execute(`document.querySelector('[data-group=settings]').click();
      document.querySelector('#reset-reports').click();
      document.querySelector('#save-preferences').click();`);
    await waitFor("!document.querySelector('#save-preferences').disabled");
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")).reports_dir, "");

    ipcMain.removeHandler("launcher:health");
    ipcMain.handle("launcher:health", () => ({ok: true, data: [
      {ok: false, label: "Sem resposta"}, {ok: true, label: "Servidor respondeu"},
    ]}));
    await execute("document.querySelector('[data-group=launcher]').click(); document.querySelector('#verify-launcher').click()");
    await waitFor("document.querySelector('#chat-status').textContent === 'Sem resposta'");
    assert.deepEqual(await execute(`(() => {
      const failure = document.querySelector('#chat-status');
      const success = document.querySelector('#decider-status');
      return [failure.dataset.error, success.hasAttribute('data-error'), getComputedStyle(failure).color !== getComputedStyle(success).color];
    })()`), ["true", false, true]);
    await execute("document.querySelector('[data-group=analysis]').click(); document.querySelector('[data-page=monitor]').click()");
    await waitFor("!document.querySelector('#page-monitor').hidden");
    assert.equal(await execute("document.querySelector('#monitor-period').options.length"), 4);
    assert.equal(await execute("document.querySelector('#monitor-refresh-hours').valueAsNumber"), 24);
    await execute("document.querySelector('#monitor-refresh').click()");
    assert.equal(await execute("document.querySelector('#monitor-refresh-hours').disabled"), true);
    await execute("document.querySelector('#monitor-refresh').click()");
    ipcMain.removeHandler("github:repositories");
    ipcMain.handle("github:repositories", () => ({ok:true, data:{login:"example", repos:["example/one", "example/two"]}}));
    await execute("document.querySelector('#monitor-load').click()");
    await waitFor("document.querySelectorAll('#monitor-repos input').length === 2");
    await execute("document.querySelector('#monitor-all').click()");
    assert.equal(await execute("document.querySelector('#monitor-scope').hidden"), true);
    if (process.platform === "win32") {
      require("../build/electron/projects.js").account = async () => "example";
      await execute(`document.querySelector('#monitor-start').value = '2099-01-01T09:00';
        document.querySelector('#monitor-refresh-hours').value = '6';
        document.querySelector('#monitor-save').click();`);
      await waitFor("document.querySelector('#monitor-next').textContent.includes('2099')");
      const schedule = await execute("window.deptriagem.invoke('monitor:status')");
      assert.equal(schedule.data.config.refreshHours, 6);
      window.close();
      assert.equal(window.isDestroyed(), false);
      assert.equal(window.isVisible(), false);
      window.show();
    }
    if (process.platform === "win32") {
      const fakeToken = "deptriagem-synthetic-control-token-for-smoke";
      const remembered = await execute(`window.deptriagem.invoke("launcher:remember-token", {token:${JSON.stringify(fakeToken)},port:8787})`);
      assert.equal(remembered.ok, true);
      const stored = fs.readFileSync(path.join(directory, "launcher-token.json"), "utf8");
      assert.ok(JSON.parse(stored).encrypted);
      assert.ok(!stored.includes(fakeToken));
      assert.equal(await execute('window.deptriagem.invoke("launcher:forget-token").then(item => item.ok)'), true);
      assert.ok(!fs.existsSync(path.join(directory, "launcher-token.json")));
    }
    const models = [
      {role:"chat", id:"m_0123456789abcdef", name:"First"},
      {role:"chat", id:"m_fedcba9876543210", name:"Second"},
      {role:"decider", id:"m_0011223344556677", name:"Decisor de teste"},
    ];
    let startModel;
    let startFailure = false;
    let watchCalls = 0;
    let watchLost = false;
    let servers = {chat: null, decider: null};
    let chatOk = true;
    ipcMain.removeHandler("launcher:watch");
    ipcMain.handle("launcher:watch", () => {
      watchCalls++;
      return watchLost ? {ok:false, message:"offline"} : {ok:true, data:{
      state:{models, servers},
      health:{chat:{ok:chatOk,label:chatOk?"Servidor respondeu":"Sem resposta"},decider:{ok:true,label:"Servidor respondeu"}},
      }};
    });
    ipcMain.removeHandler("launcher:control");
    ipcMain.handle("launcher:control", async (_event, input) => {
      if (input.action === "start" && startFailure) return {ok:false, message:"Memória insuficiente (teste)"};
      if (input.action === "start") await new Promise(resolve => { startModel = resolve; });
      return {ok:true, data:{models, servers:{chat:null, decider:null}}};
    });
    await execute("document.querySelector('[data-group=launcher]').click(); document.querySelector('#connect-launcher').click()");
    await waitFor("document.querySelector('#chat-models').options.length === 2");
    assert.equal(await execute("document.querySelector('#start-reviewer').disabled"), true);
    await waitFor("document.querySelector('#chat-status').dataset.state === 'stopped' && document.querySelector('#decider-status').dataset.state === 'stopped'");
    const stoppedColor = await execute("getComputedStyle(document.querySelector('#chat-status')).color");
    await execute(`const modelsControl = document.querySelector('#chat-models');
      modelsControl.value = 'm_fedcba9876543210';
      modelsControl.dispatchEvent(new Event('change'));
      document.querySelector('#control-port').dispatchEvent(new Event('input'));
      document.querySelector('#connect-launcher').click();`);
    await waitFor("document.querySelector('#chat-models').value === 'm_fedcba9876543210'");
    await execute("document.querySelector('#start-chat').click()");
    await waitFor("document.querySelector('#chat-status').textContent === 'Carregando'");
    assert.equal(await execute("document.querySelector('#chat-status').hasAttribute('data-state')"), false);
    for (let index = 0; !startModel && index < 80; index++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(startModel);
    startModel();
    await waitFor("document.querySelector('#chat-status').textContent === 'Parado'");
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")).launcher_models.chat, "m_fedcba9876543210");
    startFailure = true;
    await execute("document.querySelector('#start-chat').click()");
    await waitFor("document.querySelector('#chat-status').textContent === 'Falha ao iniciar'");
    const beforeFailureRefresh = watchCalls;
    for (let index = 0; watchCalls === beforeFailureRefresh && index < 280; index++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(watchCalls > beforeFailureRefresh);
    assert.equal(await execute("document.querySelector('#chat-status').textContent"), "Falha ao iniciar");
    assert.equal(await execute("document.querySelector('#chat-control-error').textContent"), "Memória insuficiente (teste)");
    startFailure = false;
    startModel = undefined;
    await execute("document.querySelector('#start-chat').click()");
    for (let index = 0; !startModel && index < 80; index++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(startModel);
    assert.equal(await execute("document.querySelector('#chat-control-error').hidden"), true);
    startModel();
    await waitFor("document.querySelector('#chat-status').textContent === 'Parado'");
    servers = {chat:{model_id:models[1].id,port:8080},decider:{model_id:"m_0011223344556677",port:8090},
      reviewer:{model_id:models[0].id,port:8083,api_model:"modelo-revisor"}};
    await waitFor("document.querySelector('#chat-status').textContent.includes('8080') && document.querySelector('#decider-status').textContent.includes('8090')", 280);
    assert.match(await execute("document.querySelector('#reviewer-status').textContent"), /8083/);
    assert.deepEqual(await execute("[...document.querySelector('#reviewer-models').options].map(item => item.value)"),
      models.filter(item => item.role === "chat").map(item => item.id));
    assert.notEqual(await execute("getComputedStyle(document.querySelector('#chat-status')).color"), stoppedColor);
    chatOk = false;
    await waitFor("document.querySelector('#chat-status').textContent.includes('Sem resposta') && document.querySelector('#chat-status').dataset.error === 'true'", 280);
    assert.equal(await execute("document.querySelector('#decider-status').textContent.includes('8090')"), true);
    watchLost = true;
    await waitFor("document.querySelector('#launcher-control-status').dataset.error === 'true'", 280);
    assert.deepEqual(await execute(`["chat","decider","reviewer"].map(role => [
      document.querySelector('#'+role+'-status').textContent,
      document.querySelector('#stop-'+role).disabled,
    ])`), [["Conexão perdida",true],["Conexão perdida",true],["Conexão perdida",true]]);
    watchLost = false;
    chatOk = true;
    await waitFor("document.querySelector('#launcher-control-status').textContent === 'Conectado'", 280);
    ipcMain.removeHandler("launcher:reviewer-models");
    ipcMain.handle("launcher:reviewer-models", (_event, input) => {
      assert.equal(input.port, 8082);
      return {ok: true, data: {source: "Servidor local fictício", models: [{id: "revisor-ficticio", label: "Revisor fictício"}]}};
    });
    await execute(`document.querySelector('#launcher-reviewer-port').value = '8082';
      document.querySelector('#launcher-reviewer-search').click();`);
    await waitFor("document.querySelector('#model-picker-list').value === 'revisor-ficticio'");
    await execute("document.querySelector('#model-picker-use').click(); document.querySelector('#launcher-reviewer-save').click()");
    await waitFor("!document.querySelector('#launcher-reviewer-save').disabled");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")).launcher_reviewer,
      {model: "revisor-ficticio", port: 8082});
    await execute(`document.querySelector('[data-page=projects]').click();
      const localReviewerChoice = document.querySelector('#project-reviewer-provider');
      localReviewerChoice.value = 'launcher-reviewer';
      localReviewerChoice.dispatchEvent(new Event('change'));
      document.querySelector('#project-reviewer-test').click();`);
    await waitFor("document.querySelector('#project-reviewer-test-status').dataset.error === 'true'");
    assert.deepEqual(testedModel, {provider: "launcher", model: "revisor-ficticio", port: 8082});
    await execute(`const automaticReview = document.querySelector('#project-reviewer-provider');
      automaticReview.value = 'launcher-reviewer-auto';
      automaticReview.dispatchEvent(new Event('change'));`);
    assert.match(await execute("document.querySelector('#project-reviewer-model-help').textContent"), /modelo principal/);
    await execute("document.querySelector('#analyze').click()");
    await waitFor("document.querySelector('#project-result').textContent.includes('Modelo principal do Launcher · principal-ficticio · porta 8080')");
    await execute("document.querySelector('#manual-usage').click()");
    let guide;
    for (let index = 0; index < 80; index++) {
      guide = BrowserWindow.getAllWindows().find(item => item !== window);
      if (guide && !guide.webContents.isLoading() && guide.webContents.getURL().endsWith("/manuais/usuario.html")) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(guide);
    assert.equal(await guide.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Manual do usuário");
    assert.equal(await guide.webContents.executeJavaScript("typeof window.deptriagem"), "undefined");
    guide.close();
    console.log("Electron", process.versions.electron, "— janela, navegação, temas e isolamento verificados.");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
})();
