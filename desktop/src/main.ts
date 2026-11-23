import {app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, safeStorage, ipcMain, nativeTheme, shell, session} from "electron";
import type {ReportProgress} from "./progress";
import {mkdirSync} from "node:fs";
import {mkdir, rm, stat} from "node:fs/promises";
import {spawn} from "node:child_process";
import {homedir} from "node:os";
import {dirname, isAbsolute, join} from "node:path";
import {pathToFileURL} from "node:url";
import {account, analyze, readRelato, repositories, review, type AnalyzeInput} from "./projects";
import {exportAnalysis} from "./reports";
import {catalogStatus, installScanner, scanner, syncCatalogs} from "./catalogs";
import {control, deciderConfig, health, localModels, reviewerChat, roles, watchLauncher, type Role, type Chat} from "./launcher";
import {credentialStatus, decideAnalysis, deciderProvider, listModels, modelConfig, modelEfforts, modelListings, modelPlan, setCredential, testModel, triageWithModel, type Provider} from "./models";
import {atomicJson, dataDir, json, message, port, resolveExecutable, run, saveSettings, settings, version, type Settings} from "./system";
import {monitorReport, monitorStatus, runMonitor, saveMonitor} from "./monitor";
import type {MonitorRun} from "./monitor-types";
import {checkUpdate, fetchUpdate, lastInstall, launchVerifiedUpdate, repository, type Update} from "./updates";
import {mcpConfig, mcpConnection, mcpTarget, testMcp} from "./mcp";
import {migratePreviousProfile} from "./migration";

const profile = join(dataDir, "electron");
mkdirSync(profile, {recursive: true});
app.setPath("userData", profile);
const index = join(__dirname, "index.html");
let window: BrowserWindow | undefined;
let manualWindow: BrowserWindow | undefined;
const manuals = new Map([["usage", "usuario.html"], ["integration", "integracoes.html"], ["diagnostics", "manutencao.html"]]
  .map(([key, file]) => [key, pathToFileURL(join(__dirname, "manuais", file)).href]));

async function openManual(name: string) {
  const url = manuals.get(name);
  if (!window || !url) throw new Error("Manual indispon\u00edvel.");
  if (!manualWindow) {
    manualWindow = new BrowserWindow({width: 880, height: 740, parent: window, autoHideMenuBar: true,
      title: "Manuais do DepTriagem", webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
    manualWindow.webContents.setWindowOpenHandler(() => ({action: "deny"}));
    manualWindow.webContents.on("will-navigate", (event, target) => {
      if (![...manuals.values()].includes(target)) event.preventDefault();
    });
    manualWindow.on("closed", () => { manualWindow = undefined; });
  }
  await manualWindow.loadURL(url);
  manualWindow?.focus();
}

let tray: Tray | undefined;
let quitting = false;
let monitorActive = false;

function openMonitor() {
  if (!window) createWindow();
  window?.show();
  window?.focus();
  window?.webContents.send("monitor:open");
}

async function updateTray() {
  monitorActive = Boolean((await monitorStatus()).config?.enabled);
  if (!monitorActive) {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (tray || process.platform !== "win32") return;
  const icon = await app.getFileIcon(process.execPath, {size: "small"});
  if (icon.isEmpty() || !monitorActive || tray) return;
  tray = new Tray(icon);
  tray.setToolTip("DepTriagem - Monitoramento GitHub");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: "Abrir monitoramento", click: openMonitor},
    {label: "Sair do DepTriagem", click: () => app.quit()},
  ]));
  tray.on("double-click", openMonitor);
}

function notifyMonitor(run: MonitorRun) {
  const added = run.repos.reduce((total, item) => total + (item.added || 0), 0);
  const failures = run.repos.filter(item => item.error).length + run.warnings.length;
  if ((added || failures) && Notification.isSupported()) {
    const notification = new Notification({
      title: added ? "DepTriagem - Novos achados" : "DepTriagem - Monitoramento com pendencias",
      body: added ? `${added} novo(s) achado(s). Abra o historico para ver os relatorios.`
        : "Consulte o historico do monitoramento.",
    });
    notification.on("click", openMonitor);
    notification.show();
  }
  window?.webContents.send("monitor:changed", run);
}

async function tickMonitor() {
  try {
    if (handingOff) return;
    const run = await runMonitor(false, step => window?.webContents.send("monitor:progress", step));
    if (run) notifyMonitor(run);
  } catch (error) {
    window?.webContents.send("monitor:error", message(error));
  }
}
let currentUpdate: Update | undefined;
let verifiedAsset: {path: string; version: string; digest: string} | undefined;
let handingOff = false;
const credentials: Partial<Record<Provider, string>> = {};

type Input = Record<string, unknown>;
function string(value: unknown) { return typeof value === "string" ? value : ""; }
function optional(value: unknown) { return string(value).trim() || undefined; }
function number(value: unknown) { return typeof value === "number" ? value : undefined; }
const chatInput = (value: unknown): Chat | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Input;
  return {port: number(input.port), model: optional(input.model), seconds: number(input.seconds)};
};

async function validateReportsDir(folder: string) {
  if (!isAbsolute(folder) || !(await stat(folder).catch(() => undefined))?.isDirectory()) {
    throw new Error("Escolha uma pasta existente para salvar os relat\u00f3rios em Configura\u00e7\u00f5es.");
  }
  return folder;
}

async function selectedMcpTarget(input: Input) {
  const target = optional(input.target);
  switch (input.kind) {
    case "catalogs": return undefined;
    case "local":
      if (!target || !isAbsolute(target)) throw new Error("Selecione a pasta do projeto.");
      return mcpTarget(target, undefined, undefined, optional(input.commit));
    case "github":
      if (!target) throw new Error("Informe o repositório do GitHub.");
      return mcpTarget(undefined, target, optional(input.ref));
    default: throw new Error("Selecione o acesso do servidor MCP.");
  }
}

function mcpDestination(host: string, workspace?: string) {
  const globalFiles = new Map([
    ["codex", [".codex", "config.toml"]],
    ["gemini", [".gemini", "settings.json"]],
    ["antigravity", [".gemini", "config", "mcp_config.json"]],
  ]);
  const projectFiles = new Map([
    ["claude", [".mcp.json"]], ["opencode", ["opencode.jsonc"]], ["opencode-v1", ["opencode.json"]],
    ["vscode", [".vscode", "mcp.json"]],
  ]);
  const globalFile = globalFiles.get(host);
  if (globalFile) return {path: join(homedir(), ...globalFile), needsWorkspace: false};
  const projectFile = projectFiles.get(host);
  if (!projectFile) throw new Error("Cliente MCP inválido.");
  if (workspace && isAbsolute(workspace)) return {path: join(workspace, ...projectFile), needsWorkspace: false};
  return {path: join(...projectFile), needsWorkspace: true};
}

const launcherTokenFile = join(dataDir, "launcher-token.json");
const tokenProtectionAvailable = () => safeStorage.isEncryptionAvailable() &&
  (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()));
async function launcherToken(value: unknown, requestedPort?: number) {
  const explicit = optional(value);
  if (explicit) return explicit;
  if (!tokenProtectionAvailable()) return undefined;
  const saved = await json<{encrypted: string; port: number}>(launcherTokenFile).catch(() => undefined);
  if (!saved || saved.port !== port(requestedPort, 8787)) return undefined;
  try { return safeStorage.decryptString(Buffer.from(saved.encrypted, "base64")); }
  catch { return undefined; }
}
async function tokenStatus() {
  return {protected: tokenProtectionAvailable(), saved: (await stat(launcherTokenFile).catch(() => undefined))?.isFile() ?? false};
}

async function automaticReviewer(primary: Chat | undefined, value: unknown, effort?: string) {
  const control = value && typeof value === "object" ? value as Input : undefined;
  const selectedPort = number(control?.port);
  const {source, ...chat} = await reviewerChat(primary, control ? {
    port: selectedPort, token: await launcherToken(control.token, selectedPort),
  } : undefined);
  return {source, model: modelConfig({provider: "launcher", ...chat, effort})};
}

function handlers() {
  return {
    "app:state": async () => ({version, settings: await settings(), dark: nativeTheme.shouldUseDarkColors,
      packaged: app.isPackaged, platform: process.platform, modelEfforts, modelListings}),
    "manual:open": (value: Input) => openManual(string(value.name)),
    "diagnostics:copy": async () => {
      const [status, scannerInfo] = await Promise.all([
        catalogStatus(), scanner().then(info => info.version, () => "indispon\u00edvel"),
      ]);
      const sources = Object.entries(status).map(([name, item]) => ({
        fonte: name, data_fonte: item?.source_updated_at ?? null, baixado_em: item?.downloaded_at ?? null,
      }));
      clipboard.writeText(JSON.stringify({
        deptriagem: version, sistema: process.platform, arquitetura: process.arch,
        electron: process.versions.electron, osv_scanner: scannerInfo, catalogos: sources,
      }, null, 2));
      return true;
    },
    "app:settings": async (value: Input) => {
      const patch: Settings = {};
      if (typeof value.catalog_dir === "string") patch.catalog_dir = value.catalog_dir.trim();
      if (typeof value.scanner === "string") patch.scanner = value.scanner.trim();
      if (typeof value.reports_dir === "string") {
        patch.reports_dir = value.reports_dir ? await validateReportsDir(value.reports_dir) : "";
      }
      if (value.theme === "system" || value.theme === "light" || value.theme === "dark") patch.theme = value.theme;
      if (typeof value.update_check === "boolean") patch.update_check = value.update_check;
      if (value.models !== undefined) patch.models = modelPlan(value.models);
      if (value.triage_decider !== undefined) patch.triage_decider = deciderConfig(value.triage_decider);
      if (value.launcher_reviewer && typeof value.launcher_reviewer === "object") {
        const {model, port: selectedPort} = chatInput(value.launcher_reviewer)!;
        if (model && (model.length > 120 || /[\x00-\x1f\x7f]/.test(model))) throw new Error("ID do Revisor local inválido.");
        patch.launcher_reviewer = {model, port: port(selectedPort, 8081)};
      }
      if (value.launcher_models && typeof value.launcher_models === "object") {
        const choices = value.launcher_models as Input;
        patch.launcher_models = Object.fromEntries(roles.flatMap(role => {
          const id = string(choices[role]);
          return /^m_[a-f0-9]{16}$/.test(id) ? [[role, id]] : [];
        }));
      }
      return saveSettings(patch);
    },
    "model:credentials": () => credentialStatus(credentials),
    "model:list": (value: Input) => listModels(string(value.provider) as Provider, {...credentials}),
    "launcher:reviewer-models": async (value: Input) => ({
      source: "Servidor do Revisor local",
      models: (await localModels(port(value.port, 8081))).map(id => ({id, label: id})),
    }),
    "model:credential": (value: Input) => {
      setCredential(credentials, string(value.provider) as Provider, value.key);
      return credentialStatus(credentials);
    },
    "model:test": async (value: Input) => {
      const local = chatInput(value.local);
      const selected = modelConfig(value.model);
      const auto = value.automaticReviewer === true ? await automaticReviewer(local, value.launcherControl, selected.effort) : undefined;
      const model = auto?.model ?? selected;
      const result = await testModel(model, {...credentials}, {provider: "launcher", ...local});
      return auto && result.status === "connected"
        ? {...result, detail: `Conectado · ${auto.source === "dedicated" ? "Revisor dedicado" : "Modelo principal"} · ${model.model || "modelo-local"} · porta ${model.port ?? 8080}`} : result;
    },
    "mcp:destination": (value: Input) => mcpDestination(string(value.host), optional(value.workspace)),
    "mcp:preview": async (value: Input) => mcpConfig(string(value.host), await selectedMcpTarget(value), true),
    "mcp:copy": async (value: Input) => {
      clipboard.writeText(mcpConfig(string(value.host), await selectedMcpTarget(value), true));
      return true;
    },
    "mcp:test": async (value: Input, progress?: ReportProgress) => testMcp(await selectedMcpTarget(value), progress),
    "mcp:connection": async (value: Input) => mcpConnection(string(value.host), await selectedMcpTarget(value)),
    "mcp:open-location": async (value: Input) => {
      const destination = mcpDestination(string(value.host), optional(value.workspace));
      if (destination.needsWorkspace) throw new Error("Selecione a pasta de trabalho do cliente.");
      if ((await stat(destination.path).catch(() => undefined))?.isFile()) {
        shell.showItemInFolder(destination.path);
        return true;
      }
      let directory = dirname(destination.path);
      while (!(await stat(directory).catch(() => undefined))?.isDirectory()) {
        const parent = dirname(directory);
        if (directory === parent) throw new Error("Não foi possível localizar a pasta de configuração.");
        directory = parent;
      }
      const error = await shell.openPath(directory);
      if (error) throw new Error(error);
      return true;
    },
    "app:pick": async (value: Input) => {
      const type = string(value.type);
      const types: Record<string, Electron.FileFilter[]> = {
        report: [{name: "Arquivos JSON", extensions: ["json"]}],
        text: [{name: "Texto", extensions: ["txt", "md"]}],
        scanner: process.platform === "win32" ? [{name: "Executável Windows", extensions: ["exe"]}] : [],
        folder: [],
      };
      if (!Object.hasOwn(types, type) || !window) throw new Error("Tipo de arquivo inválido.");
      const result = await dialog.showOpenDialog(window, {
        properties: type === "folder" ? ["openDirectory"] : ["openFile"], filters: types[type],
      });
      return result.canceled ? null : result.filePaths[0];
    },
    "app:read-report": (value: Input) => readRelato(string(value.path)),
    "app:save-report": async (value: Input) => {
      if (!window || value.report === undefined) return false;
      const configured = (await settings()).reports_dir;
      const root = configured ? await validateReportsDir(configured) : join(dataDir, "reports");
      if (!configured) await mkdir(root, {recursive: true});
      const choice = await dialog.showSaveDialog(window, {defaultPath: join(root, "deptriagem-relatorio.json"),
        filters: [{name: "Relatório JSON", extensions: ["json"]}]});
      if (choice.canceled || !choice.filePath) return false;
      await atomicJson(choice.filePath, value.report);
      return true;
    },
    "app:export-analysis": async (value: Input) => {
      if (!window || !value.report || typeof value.report !== "object") return null;
      const report = value.report as Awaited<ReturnType<typeof analyze>>;
      if (report.schema_version !== 1 || !Array.isArray(report.findings) || !report.source) throw new Error("Relatório de análise inválido.");
      const configured = (await settings()).reports_dir;
      const root = configured ? await validateReportsDir(configured) : join(dataDir, "reports");
      await mkdir(root, {recursive: true});
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const choice = await dialog.showSaveDialog(window, {title: "Nome da pasta da exportação",
        defaultPath: join(root, "deptriagem-" + stamp), buttonLabel: "Exportar"});
      return choice.canceled || !choice.filePath ? null : exportAnalysis(choice.filePath, report);
    },
    "github:configured": async () => {
      if (process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()) return true;
      const result = await run("gh", ["config", "get", "user", "--host", "github.com"], {timeout: 5000})
        .catch(() => null);
      return result?.code === 0 && Boolean(result.output.toString().trim());
    },
    "github:account": () => account(),
    "github:repositories": () => repositories(),
    "github:login": async () => {
      if (process.platform !== "win32") throw new Error("Execute gh auth login --web no terminal.");
      const gh = await resolveExecutable("gh");
      const command = join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
      if (!isAbsolute(command) || /["%\r\n]/.test(gh)) throw new Error("Execute gh auth login --web no terminal.");
      return new Promise<boolean>((resolve, reject) => {
        const child = spawn(command, ["/d", "/v:off", "/k", `""${gh}" auth login --hostname github.com --web"`],
          {detached: true, stdio: "ignore", windowsVerbatimArguments: true,
            env: {...process.env, NoDefaultCurrentDirectoryInExePath: "1"}});
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(true); });
      });
    },
    "project:analyze": async (value: Input, progress?: ReportProgress) => {
      const guidance = value.models === false ? undefined : chatInput(value.guidance);
      const models = value.models === false ? undefined : modelPlan(value.models);
      const auto = models && value.automaticReviewer === true
        ? await automaticReviewer(guidance, value.launcherControl, models.reviewer.effort) : undefined;
      if (models && auto) models.reviewer = auto.model;
      return analyze({
        kind: string(value.kind) as AnalyzeInput["kind"], target: string(value.target), ref: optional(value.ref),
        commit: optional(value.commit), catalog_dir: optional(value.catalog_dir), scanner: optional(value.scanner),
        models, reviewerLauncher: auto && {source: auto.source, model: auto.model.model ?? "modelo-local", port: auto.model.port ?? 8080},
        decider: value.decider ? deciderConfig(value.decider) : undefined, guidance,
        allowExternal: value.allowExternal === true, credentials: {...credentials},
      }, progress);
    },
    "monitor:status": () => monitorStatus(),
    "monitor:save": async (value: Input) => {
      await saveMonitor(value);
      await updateTray();
      return monitorStatus();
    },
    "monitor:run": async (_: Input, progress?: ReportProgress) => {
      if (handingOff) throw new Error("Uma atualiza\u00e7\u00e3o est\u00e1 em andamento.");
      const run = await runMonitor(true, progress);
      if (!run) throw new Error("Salve a configuracao ou aguarde a execucao em andamento.");
      notifyMonitor(run);
      return monitorStatus();
    },
    "monitor:open-report": async (value: Input) => {
      const path = await monitorReport(value.id, value.repo);
      if (!path || !(await stat(path).catch(() => undefined))?.isFile()) throw new Error("Relatorio indisponivel.");
      shell.showItemInFolder(path);
      return true;
    },
    "project:review": (value: Input) => review(string(value.osv), string(value.kev)),
    "catalog:status": (value: Input) => catalogStatus(optional(value.path)),
    "catalog:sync": (value: Input, progress?: ReportProgress) => syncCatalogs(optional(value.path), value.source || undefined, progress,
      optional(value.scanner)),
    "catalog:scanner": (value: Input) => scanner(optional(value.path)),
    "catalog:install": (_: Input, progress?: ReportProgress) => installScanner(progress),
    "launcher:open": async () => {
      if (process.platform === "win32") {
        const shortcut = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Llama Desktop Launcher.lnk");
        if ((await stat(shortcut).catch(() => undefined))?.isFile() && !await shell.openPath(shortcut)) return true;
        throw new Error("Abra o Llama Desktop Launcher pelo menu Iniciar.");
      }
      const target = process.platform === "darwin" ? ["open", "-a", "Llama Desktop Launcher"] : ["llama-desktop-launcher"];
      const [program, ...args] = target;
      const executable = await resolveExecutable(program);
      return new Promise<boolean>((resolve, reject) => {
        const child = spawn(executable, args, {windowsHide: true, detached: true, stdio: "ignore",
          env: {...process.env, ...(process.platform === "win32" ? {NoDefaultCurrentDirectoryInExePath: "1"} : {})}});
        child.once("error", () => reject(new Error("Abra o Llama Desktop Launcher pelo menu ou pelo execut\u00e1vel instalado.")));
        if (process.platform === "darwin") {
          child.once("close", code => code === 0 ? resolve(true) : reject(new Error("Llama Desktop Launcher indispon\u00edvel.")));
        } else child.once("spawn", () => { child.unref(); resolve(true); });
      });
    },
    "launcher:token-status": () => tokenStatus(),
    "launcher:remember-token": async (value: Input) => {
      const token = optional(value.token);
      if (!token || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error("Informe o token de controle do Launcher.");
      if (!tokenProtectionAvailable()) throw new Error("O armazenamento protegido n\u00e3o est\u00e1 dispon\u00edvel neste sistema.");
      await atomicJson(launcherTokenFile, {port: port(number(value.port), 8787), encrypted: safeStorage.encryptString(token).toString("base64")});
      return tokenStatus();
    },
    "launcher:forget-token": async () => {
      await rm(launcherTokenFile, {force: true});
      return tokenStatus();
    },
    "launcher:watch": async (value: Input) => watchLauncher({port: number(value.port), token: await launcherToken(value.token, number(value.port))}),
    "launcher:control": async (value: Input) => control(string(value.action), {role: optional(value.role) as Role | undefined,
      port: number(value.port), token: await launcherToken(value.token, number(value.port)), model_id: optional(value.model_id)}),
    "launcher:health": (value: Input) => Promise.all([
      health("chat", number(value.chat)), health("decider", number(value.decider)),
    ]),
    "triage:run": (value: Input) => {
      const decider = deciderConfig(value.decider);
      const note = value.note === true ? decider.mode === "chat" || decider.mode === "opencode-local" ?
        {port: decider.port, model: decider.model} : chatInput(value.launcherChat) : undefined;
      return triageWithModel(string(value.report), decider, undefined, note, value.allowExternal === true, {...credentials});
    },
    "triage:test": async (value: Input) => {
      const decider = deciderConfig(value.decider);
      const keys = {...credentials};
      const result = value.analysis === true ? await decideAnalysis({
        packages_reported: 3, findings_count: 1, maximum_priority_count: 1,
        coverage: "inventory_scanned", coverage_issues: [],
      }, decider, true, keys) : await triageWithModel("Relato fictício: o botão Voltar voltou para a página inicial.", decider,
        undefined, undefined, true, keys);
      return {ok: result.reason !== "decider_unavailable", detail: result.detail};
    },
    "triage:models": async (value: Input) => {
      const decider = deciderConfig(value.decider);
      if (decider.mode === "opencode-local" || decider.mode === "chat") {
        return {source: "Servidor local em 127.0.0.1", models: (await localModels(decider.port)).map(id => ({id, label: id}))};
      }
      return listModels(deciderProvider(decider.mode), {...credentials});
    },
    "update:last-install": () => lastInstall(),
    "update:check": async () => {
      verifiedAsset = undefined;
      currentUpdate = await checkUpdate();
      return currentUpdate;
    },
    "update:download": async (_: Input, progress?: ReportProgress) => {
      const update = currentUpdate;
      if (!update?.version || !update.sha256) throw new Error("Consulte as releases primeiro.");
      const path = await fetchUpdate(update, undefined, progress);
      verifiedAsset = {path, version: update.version, digest: update.sha256};
      if (process.platform !== "win32") shell.showItemInFolder(path);
      return {asset: path, canInstall: app.isPackaged && process.platform === "win32"};
    },
    "update:install": async () => {
      const asset = verifiedAsset;
      if (!app.isPackaged || !asset || !window || handingOff) throw new Error("Atualiza\u00e7\u00e3o verificada n\u00e3o dispon\u00edvel.");
      handingOff = true;
      try {
        if ((await monitorStatus()).running) throw new Error("Aguarde a execu\u00e7\u00e3o do monitoramento terminar.");
        const {response} = await dialog.showMessageBox(window, {type: "question", title: "Atualizar DepTriagem",
          buttons: ["Cancelar", "Abrir instalador"], defaultId: 0, cancelId: 0,
          message: "Salve o trabalho aberto antes de atualizar.", detail: "O DepTriagem fechar\u00e1 e o instalador ser\u00e1 exibido."});
        if (!response) { handingOff = false; return false; }
        await launchVerifiedUpdate(asset.path, process.execPath, asset.digest, asset.version);
        setImmediate(() => app.quit());
        return true;
      } catch (error) {
        handingOff = false;
        throw error;
      }
    },
    "update:open-release": () => shell.openExternal(currentUpdate?.url || `https://github.com/${repository}/releases`),
  };
}

function createWindow() {
  const options: Electron.BrowserWindowConstructorOptions = {
    width: 1150, height: 780, minWidth: 820, minHeight: 600, title: "DepTriagem",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e151a" : "#eef4f1", autoHideMenuBar: true,
    webPreferences: {preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true,
      nodeIntegration: false, devTools: !app.isPackaged, webSecurity: true},
  };
  window = new BrowserWindow(options);
  window.webContents.setWindowOpenHandler(() => ({action: "deny"}));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.on("close", event => {
    if (!quitting && tray && monitorActive) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => { window = undefined; });
  void window.loadFile(index);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("before-quit", () => { quitting = true; });
  if (process.platform === "win32") app.setAppUserModelId("io.github.valmorbida4-eng.deptriagem");
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  void app.whenReady().then(async () => {
    const migrationError = await migratePreviousProfile().then(() => false, () => true);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    for (const [channel, handle] of Object.entries(handlers())) {
      ipcMain.handle(channel, async (event, parameters: unknown) => {
        if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(index).href ||
          event.senderFrame !== window.webContents.mainFrame) throw new Error("Origem do pedido inválida.");
        const input = (parameters || {}) as Input;
        const id = string(input.progressId);
        const progress: ReportProgress | undefined = /^[0-9-]{1,40}$/.test(id) ? step => {
          if (!event.sender.isDestroyed()) event.sender.send("operation:progress", id, step);
        } : undefined;
        try { return {ok: true, data: await handle(input, progress)}; }
        catch (error) { return {ok: false, message: message(error)}; }
      });
    }
    nativeTheme.on("updated", () => window?.webContents.send("theme:changed", nativeTheme.shouldUseDarkColors));
    createWindow();
    if (migrationError) void dialog.showMessageBox({type: "warning", title: "Migração do perfil",
      message: "A cópia do perfil anterior ficou incompleta. Confira as preferências e os catálogos."});
    void updateTray().catch(error => window?.webContents.send("monitor:error", message(error)));
    void tickMonitor();
    const timer = setInterval(() => { void tickMonitor(); }, 30_000);
    app.once("will-quit", () => clearInterval(timer));
    app.on("activate", () => { if (!window) createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
