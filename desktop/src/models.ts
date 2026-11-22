import {access, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {chat, externalDecider, LauncherResponseError, ModelExecutionError, triage, type Chat, type DeciderConfig} from "./launcher";
import {port, resolveExecutable, run} from "./system";

export const providers = ["off", "launcher", "openai", "codex", "claude", "opencode-cli", "agy", "opencode", "gemini"] as const;
export type Provider = typeof providers[number];
const standardEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export const modelEfforts: Partial<Record<Provider, readonly string[]>> = {
  openai: ["none", "minimal", ...standardEfforts], codex: ["minimal", ...standardEfforts], claude: standardEfforts,
  "opencode-cli": ["none", "minimal", ...standardEfforts], agy: standardEfforts,
  gemini: ["low", "medium", "high"], launcher: ["none", "server"],
};
export interface Model {provider: Provider; model?: string; effort?: string; port?: number; seconds?: number}
export interface ModelPlan {agent: Model; reviewer: Model}
export interface ListedModel {id: string; label: string; efforts?: string[]}
export const modelListings: readonly Provider[] = ["codex", "claude", "opencode-cli", "agy"];
type Credentials = Partial<Record<Provider, string>>;
const checks = {
  review_lockfiles: "Revisar manifestos e lockfiles ausentes ou incompletos.",
  check_runtime_scope: "Confirmar em quais ambientes e componentes os pacotes são usados.",
  review_catalog_coverage: "Conferir os ecossistemas e as datas das fontes.",
  review_vendor_fixes: "Conferir correções e versões no advisory do mantenedor.",
  review_application_code: "Executar uma revisão separada do código da aplicação.",
};
type Check = keyof typeof checks;
const schema = {type: "object", required: ["checks"], additionalProperties: false, properties: {
  checks: {type: "array", items: {type: "string", enum: Object.keys(checks)}},
}};
const envKeys: Partial<Record<Provider, string>> = {
  openai: "OPENAI_API_KEY", claude: "ANTHROPIC_API_KEY", opencode: "OPENCODE_API_KEY", agy: "GEMINI_API_KEY", gemini: "GEMINI_API_KEY",
};
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/~-]{0,119}$/;
export const external = (provider: Provider) => provider !== "off" && provider !== "launcher";

export function modelConfig(value: unknown, fallback: Provider = "off"): Model {
  const input = (value ?? {}) as Partial<Model>;
  const provider = input.provider ?? fallback;
  if (!providers.includes(provider)) throw new Error("Provedor de IA inválido.");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (model && provider !== "launcher" && !modelId.test(model)) {
    throw new Error("Identificador de modelo inválido.");
  }
  const effort = typeof input.effort === "string" ? input.effort.trim() : "";
  if (effort && !modelEfforts[provider]?.includes(effort)) throw new Error("Esfor\u00e7o incompat\u00edvel com o provedor.");
  return {provider, model: model || undefined, effort: effort || undefined, port: provider === "launcher" && input.port !== undefined ? port(input.port) : undefined,
    seconds: Number.isFinite(input.seconds) ? Math.max(1, Math.min(provider === "launcher" ? 900 : 120, input.seconds!)) : undefined};
}

export function modelPlan(value: unknown): ModelPlan {
  const plan = (value ?? {}) as Partial<ModelPlan>;
  return {agent: modelConfig(plan.agent, "launcher"), reviewer: modelConfig(plan.reviewer)};
}

function credential(provider: Provider, credentials: Credentials) {
  const key = envKeys[provider];
  return key ? credentials[provider] || process.env[key] ||
    (provider === "gemini" ? process.env.GOOGLE_API_KEY : undefined) : undefined;
}

export function credentialStatus(credentials: Credentials) {
  return Object.fromEntries(Object.keys(envKeys).map(key => [key, Boolean(credential(key as Provider, credentials))]));
}

export function setCredential(credentials: Credentials, provider: Provider, key: unknown) {
  if (!Object.hasOwn(envKeys, provider) || typeof key !== "string" || key.length > 4096 ||
      (key && !/^[\x21-\x7e]+$/.test(key))) throw new Error("Credencial inválida.");
  if (key) credentials[provider] = key;
  else delete credentials[provider];
}

function selections(raw: string): Check[] {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")) as {checks?: unknown[]};
  if (!Array.isArray(value.checks) || value.checks.length > 5 ||
      value.checks.some(key => typeof key !== "string" || !Object.hasOwn(checks, key))) throw new Error("Formato inválido.");
  return [...new Set(value.checks)] as Check[];
}

async function post(url: string, headers: Record<string, string>, input: object, seconds: number) {
  return providerJson(url, {method: "POST", headers: {"Content-Type": "application/json", ...headers},
    body: JSON.stringify(input)}, seconds);
}

async function providerJson(url: string, init: RequestInit, seconds: number) {
  const response = await fetch(url, {...init, redirect: "error", signal: AbortSignal.timeout(seconds * 1000)});
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (init.method !== "POST" && [400, 401, 403].includes(response.status)) {
      throw new Error("A API recusou a consulta ao catálogo. Confira a chave e o acesso aos modelos.");
    }
    throw new Error("Falha na API do provedor.");
  }
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await stream.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw new Error("Resposta muito grande.");
      chunks.push(value);
    }
  } finally { await stream.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function runtimeEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|pathext|systemroot|windir|comspec|home|userprofile|appdata|localappdata|temp|tmp|tmpdir|programfiles|programfiles\(x86\))$/i.test(name))
    .map(([name, value]) => [process.platform === "win32" ? name.toUpperCase() : name, value]));
}

function isolatedEnv(cwd: string) {
  return {...runtimeEnv(), HOME: cwd, USERPROFILE: cwd, APPDATA: cwd, LOCALAPPDATA: cwd,
    XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data"),
    XDG_CACHE_HOME: join(cwd, "cache"), XDG_STATE_HOME: join(cwd, "state")};
}

async function openCodeProgram() {
  if (process.platform === "win32" && process.env.APPDATA) {
    const installed = join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (await access(installed).then(() => true, () => false)) return installed;
  }
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

const openCodeKeys: Record<string, string> = {
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY",
  opencode: "OPENCODE_API_KEY", "opencode-go": "OPENCODE_GO_API_KEY",
  "fireworks-ai": "FIREWORKS_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", zenmux: "ZENMUX_API_KEY",
};

async function openCodeAuth(): Promise<Record<string, unknown>> {
  const path = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json");
  try {
    const auth: unknown = JSON.parse(await readFile(path, "utf8"));
    if (auth && typeof auth === "object" && !Array.isArray(auth)) return auth as Record<string, unknown>;
  } catch { /* Credenciais exportadas continuam disponíveis. */ }
  return {};
}

function connectedOpenCodeProviders(auth: Record<string, unknown>) {
  return Object.entries(auth).filter(([provider, record]) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(provider) &&
    record && typeof record === "object" && (record as {type?: string}).type === "api").map(([provider]) => provider);
}

async function openCodeSession(cwd: string, providers: string[], configured: Record<string, unknown> = {}) {
  const program = await openCodeProgram();
  const isolated = isolatedEnv(cwd);
  const installed = await run(program, ["--version"], {cwd, env: isolated, timeout: 15_000, limit: 8192});
  if (installed.code || !/^v?1\./m.test(installed.output.toString())) throw new Error("Instale o OpenCode CLI 1.x.");
  const auth = Object.fromEntries(providers.filter(provider => Object.hasOwn(configured, provider))
    .map(provider => [provider, configured[provider]]));
  const keys = Object.fromEntries(providers.filter(provider => Object.hasOwn(openCodeKeys, provider))
    .map(provider => [openCodeKeys[provider], process.env[openCodeKeys[provider]] ??
      (provider === "google" ? process.env.GEMINI_API_KEY : undefined)]));
  const catalog = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json");
  const cached = providers.length ? await stat(catalog).catch(() => undefined) : undefined;
  const env = {...isolated,
    OPENCODE_MODELS_PATH: cached?.isFile() && cached.size <= 16 * 1024 ** 2 ? catalog : undefined,
    OPENCODE_AUTH_CONTENT: JSON.stringify(auth), OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_PERMISSION: '{"*":"deny"}', OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"deny"},"mcp":{},"plugin":[]}',
    ...keys,
  };
  return {program, env};
}

async function runOpenCode(model: Model, prompt: string, cwd: string, timeout: number, localPort?: number) {
  const id = model.model;
  if (!id || !modelId.test(id)) throw new Error("Informe o ID do modelo do OpenCode.");
  const [provider] = id.split("/");
  const auth = localPort === undefined ? await openCodeAuth() : {};
  if (localPort === undefined && (!id.includes("/") ||
    !(Object.hasOwn(openCodeKeys, provider) || connectedOpenCodeProviders(auth).includes(provider)))) {
    throw new Error("Informe provedor/modelo de um provedor integrado do OpenCode CLI.");
  }
  const {program, env} = await openCodeSession(cwd, localPort === undefined ? [provider] : [], auth);
  if (localPort !== undefined) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...JSON.parse(env.OPENCODE_CONFIG_CONTENT), enabled_providers: ["deptriagem-local"],
      provider: {"deptriagem-local": {npm: "@ai-sdk/openai-compatible", name: "Servidor local do DepTriagem",
        options: {baseURL: `http://127.0.0.1:${localPort}/v1`, apiKey: process.env.DEPTRIAGEM_CHAT_TOKEN || "local"},
        models: {[id]: {name: id, tool_call: false}},
      }},
    });
  }
  const attachment = join(cwd, "orientacao.txt");
  await writeFile(attachment, prompt, {flag: "wx", mode: 0o600});
  const args = ["run", "--pure", "--format", "json", "--model", localPort === undefined ? id : "deptriagem-local/" + id,
    ...(model.effort ? ["--variant", model.effort] : []), "--file", attachment, "--", "Responda à orientação no arquivo anexado."];
  const runResult = await run(program, args, {cwd, env, timeout, limit: 256 * 1024});
  if (runResult.code) throw new Error("OpenCode CLI indispon\u00edvel.");
  const events = runResult.output.toString().trim().split(/\r?\n/).map(line => JSON.parse(line));
  return events.filter(item => item.type === "text").map(item => item.part?.text ?? item.text).join("");
}

export function deciderProvider(mode: DeciderConfig["mode"]): Provider {
  return mode === "opencode" || mode === "opencode-local" ? "opencode-cli"
    : mode === "opencode-zen" ? "opencode" : externalDecider(mode) ? mode as Provider : "off";
}

export function triageWithModel(report: string, config: DeciderConfig, threshold?: number, note?: Chat, allowExternal = false,
  credentials: Credentials = {}, analysis = false) {
  if (!externalDecider(config.mode) && config.mode !== "opencode-local") return triage(report, config, threshold, note, {analysis});
  return triage(report, config, threshold, note, {analysis, allowExternal, runModel: async (messages, responseSchema) => {
    const model = modelConfig({provider: deciderProvider(config.mode), model: config.model, effort: config.effort});
    if (config.mode !== "opencode-local") {
      return modelResponse(model, messages[0].content, messages[1].content, credentials, responseSchema, "deptriagem_routing");
    }
    const cwd = await mkdtemp(join(tmpdir(), "deptriagem-opencode-decision-"));
    try {
      return await runOpenCode(model, messages.map(message => message.content).join("\n"), cwd, 120_000, port(config.port, 8080));
    } finally { await rm(cwd, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }
  }});
}

interface AnalysisDecisionEvidence {
  packages_reported: number;
  findings_count: number;
  maximum_priority_count: number;
  coverage: "partial" | "inventory_scanned";
  coverage_issues: string[];
}

export function decideAnalysis(evidence: AnalysisDecisionEvidence, config: DeciderConfig, allowExternal = false, credentials: Credentials = {}) {
  return triageWithModel(JSON.stringify(evidence), config, undefined, undefined, allowExternal, credentials, true);
}

async function codexCommand(args: string[], env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && process.env.APPDATA) {
    const shim = join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (await access(shim).then(() => true, () => false)) {
      return {program: process.execPath, args: [shim, ...args], env: {...env, ELECTRON_RUN_AS_NODE: "1"}};
    }
  }
  return {program: "codex", args, env};
}

async function codexModels(cwd: string): Promise<ListedModel[]> {
  const codex = await codexCommand(["app-server", "--stdio", "--disable", "plugins", "--disable", "hooks",
    "-c", "mcp_servers={}"], {...runtimeEnv(), CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY});
  const executable = await resolveExecutable(codex.program, codex.env, cwd);
  const child = spawn(executable, codex.args, {cwd, env: {...codex.env, ...(process.platform === "win32" ?
    {NoDefaultCurrentDirectoryInExePath: "1"} : {})}, windowsHide: true, stdio: ["pipe", "pipe", "ignore"]});
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity, terminal: false});
  const replies = lines[Symbol.asyncIterator]();
  let failure = "O Codex CLI encerrou antes de listar os modelos.";
  const stop = (message: string) => {
    failure = message;
    lines.close();
    child.kill();
  };
  child.on("error", () => stop("Não foi possível iniciar o Codex CLI."));
  child.stdin.on("error", () => lines.close());
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) stop("A lista do Codex CLI excedeu o limite permitido.");
  });
  const timeout = setTimeout(() => stop("O Codex CLI excedeu o tempo de resposta."), 20_000);
  const send = (method: string, id?: number, params?: object) =>
    child.stdin.write(JSON.stringify({method, id, params}) + "\n");
  async function receive(id: number) {
    for (;;) {
      const next = await replies.next();
      if (next.done) throw new Error(failure);
      const reply = JSON.parse(next.value);
      if (reply.id === id) {
        if (!reply.result || reply.error) throw new Error("O Codex CLI não retornou a lista de modelos.");
        return reply.result;
      }
    }
  }
  try {
    send("initialize", 1, {clientInfo: {name: "deptriagem_model_picker", version: "1"}});
    await receive(1);
    send("initialized");
    const models: ListedModel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const id = 2 + page;
      send("model/list", id, {limit: 100, cursor, includeHidden: false});
      const result = await receive(id);
      if (!Array.isArray(result.data)) throw new Error("Lista de modelos inválida do Codex CLI.");
      for (const row of result.data) {
        if (!row || row.hidden || typeof row.model !== "string") continue;
        const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts
          .map((item: {reasoningEffort?: string}) => item?.reasoningEffort)
          .filter((effort: string) => modelEfforts.codex!.includes(effort)) : undefined;
        models.push({id: row.model, label: typeof row.displayName === "string" ? row.displayName : row.model, efforts});
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursor === result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return models;
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function claudeModels(key: string) {
  const models: ListedModel[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL("https://api.anthropic.com/v1/models?limit=50");
    if (after) url.searchParams.set("after_id", after);
    const response = await providerJson(url.href, {headers: {"anthropic-version": "2023-06-01", "x-api-key": key}}, 15);
    if (!Array.isArray(response.data)) throw new Error("Lista de modelos inválida da Anthropic.");
    for (const row of response.data) {
      if (typeof row?.id !== "string") continue;
      const meta = row.capabilities?.effort;
      const efforts = meta ? standardEfforts.filter(effort => meta[effort]?.supported === true) : undefined;
      models.push({id: row.id, label: typeof row.display_name === "string" ? row.display_name : row.id, efforts});
    }
    if (!response.has_more || typeof response.last_id !== "string" || after === response.last_id) break;
    after = response.last_id;
  }
  return models;
}

async function claudeCliModels(): Promise<ListedModel[]> {
  const args = ["--print", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "", "--permission-mode", "dontAsk", "--no-session-persistence",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  const id = "deptriagem-models";
  const result = await run("claude", args, {cwd: tmpdir(), timeout: 20_000, limit: 512 * 1024,
    env: {...runtimeEnv(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR},
    input: JSON.stringify({type: "control_request", request_id: id, request: {subtype: "initialize"}}) + "\n",
  });
  const failure = () => new Error("O Claude Code não retornou modelos. Verifique a sessão do CLI ou cadastre a chave Anthropic.");
  if (result.code) throw failure();
  for (const line of result.output.toString().split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    const frame = JSON.parse(line);
    const reply = frame?.response;
    if (frame?.type !== "control_response" || reply?.request_id !== id) continue;
    if (reply.subtype !== "success" || !Array.isArray(reply.response?.models)) throw failure();
    return reply.response.models.flatMap((row: {value?: string; displayName?: string; supportedEffortLevels?: string[]; supportsEffort?: boolean}) => {
      if (typeof row?.value !== "string") return [];
      const declared = row.supportedEffortLevels;
      const efforts = Array.isArray(declared) ? standardEfforts.filter(effort => declared.includes(effort))
        : row.supportsEffort === false ? [] : undefined;
      return [{id: row.value, label: typeof row.displayName === "string" ? row.displayName : row.value, efforts}];
    });
  }
  throw failure();
}

async function agyCliModels() {
  // The CLI can leave a Windows process holding its working directory briefly after exit.
  const result = await run(process.platform === "win32" ? "agy.exe" : "agy", ["models"], {
    cwd: tmpdir(), env: runtimeEnv(), timeout: 20_000, limit: 512 * 1024,
  });
  if (result.code) {
    if (/sign in|not logged in|gemini_api_key/i.test(result.diagnostics)) {
      throw new Error("Entre na conta pelo Antigravity CLI ou cadastre a chave Gemini para consultar modelos.");
    }
    throw new Error("O Antigravity CLI não retornou a lista de modelos. Verifique a conexão do CLI.");
  }
  return result.output.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).flatMap(line => {
    const match = /^(\S+)(?:\t+| {2,})(\S.*)$/.exec(line.trim());
    return match ? [{id: match[1], label: match[2].trim()}] : [];
  });
}

async function geminiModelIds(key: string) {
  const models: ListedModel[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100");
    if (token) url.searchParams.set("pageToken", token);
    const response = await providerJson(url.href, {headers: {"x-goog-api-key": key}}, 15);
    if (!Array.isArray(response.models)) throw new Error("Lista de modelos inválida do Gemini.");
    for (const row of response.models) {
      if (typeof row?.name !== "string" || !row.name.startsWith("models/gemini-") ||
          !Array.isArray(row.supportedGenerationMethods) || !row.supportedGenerationMethods.includes("generateContent")) continue;
      const id = row.name.slice("models/".length);
      models.push({id, label: typeof row.displayName === "string" ? row.displayName : id,
        efforts: row.thinking === false ? [] : undefined});
    }
    if (typeof response.nextPageToken !== "string" || !response.nextPageToken || token === response.nextPageToken) break;
    token = response.nextPageToken;
  }
  return models;
}

export async function listModels(provider: Provider, credentials: Credentials = {}) {
  if (!modelListings.includes(provider)) throw new Error("A busca de modelos não está disponível para este provedor.");
  const key = credential(provider, credentials);
  let models: ListedModel[];
  let source: string;
  if (provider === "claude") {
    models = key ? await claudeModels(key) : await claudeCliModels();
    source = key ? "Catálogo da API Anthropic" : "Claude Code CLI";
  } else if (provider === "agy") {
    models = key ? await geminiModelIds(key) : await agyCliModels();
    source = key ? "Catálogo da API Gemini usada pelo Antigravity" : "Antigravity CLI";
  } else {
    const cwd = await mkdtemp(join(tmpdir(), "deptriagem-model-list-"));
    try {
      if (provider === "codex") {
        models = await codexModels(cwd);
        source = "Codex CLI";
      } else {
        const auth = await openCodeAuth();
        const providers = [...new Set([...Object.keys(openCodeKeys), ...connectedOpenCodeProviders(auth)])];
        const {program, env} = await openCodeSession(cwd, providers, auth);
        const result = await run(program, ["models", "--pure"], {cwd, env, timeout: 20_000, limit: 512 * 1024});
        if (result.code) throw new Error("O OpenCode CLI não retornou a lista de modelos.");
        models = result.output.toString().split(/\r?\n/).map(line => line.trim())
          .filter(id => id.includes("/") && providers.includes(id.split("/")[0])).map(id => ({id, label: id}));
        source = "OpenCode CLI";
      }
    } finally {
      await rm(cwd, {recursive: true, force: true, maxRetries: 4, retryDelay: 100});
    }
  }
  const unique = new Map<string, ListedModel>();
  for (const model of models) {
    if (modelId.test(model.id) && !unique.has(model.id)) unique.set(model.id, {...model, label: model.label.slice(0, 160)});
  }
  return {source, models: [...unique.values()].slice(0, 2_000)};
}

function cliExecutionError(provider: string, diagnostic: string, apiKey: boolean) {
  if (/failed to authenticate|authentication required|not logged in|sign in|oauth session expired|invalid.*api.key|unauthorized/i.test(diagnostic)) {
    return new ModelExecutionError(apiKey ? `O ${provider} recusou a chave. Confira a credencial da sessão.`
      : `A sessão do ${provider} está indisponível ou expirada. Renove o login na CLI e teste novamente.`);
  }
  if (/invalid model selection|model.*(?:not found|not available|not recognized|unsupported|invalid)|(?:invalid|unsupported).*effort/i.test(diagnostic)) {
    return new ModelExecutionError(`O ${provider} recusou o modelo ou o esforço. Escolha novamente em Buscar modelos.`);
  }
  return new ModelExecutionError(`O ${provider} não concluiu a consulta.`);
}

async function runAgy(model: Model, prompt: string, cwd: string, timeout: number, key: string | undefined, responseSchema: object) {
  const settings = JSON.stringify({
    modelProvider: key ? "gemini" : "", agentMode: "plan", toolPermission: "strict", allowNonWorkspaceAccess: false, historySize: 0,
    permissions: {deny: ["command(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"]},
  });
  const args = ["--settings", settings, "--sandbox", "--disable-slash-commands",
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--json-schema", JSON.stringify(responseSchema),
    ...(model.model ? ["--model", model.model] : []), ...(model.effort ? ["--effort", model.effort] : [])];
  const input = JSON.stringify({event: "user", message: {content: prompt}}) + "\n";
  const result = await run(process.platform === "win32" ? "agy.exe" : "agy", args, {cwd: tmpdir(), timeout, limit: 256 * 1024,
    input, env: {...isolatedEnv(cwd), GEMINI_API_KEY: key}});
  const output = result.output.toString();
  if (result.code) throw cliExecutionError("Antigravity CLI", result.diagnostics + output, Boolean(key));
  const response = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as {
    event?: string; result?: {status?: string; response?: unknown; error?: string};
  }).findLast(event => event?.event === "result")?.result;
  if (response?.status !== "SUCCESS") throw cliExecutionError("Antigravity CLI", response?.error ?? "", Boolean(key));
  if (typeof response.response === "string") return response.response;
  if (response.response && typeof response.response === "object") return JSON.stringify(response.response);
  throw new ModelExecutionError("O Antigravity CLI não retornou uma resposta.");
}

async function runAgent(model: Model, prompt: string, key: string | undefined, responseSchema: object) {
  const cwd = await mkdtemp(join(tmpdir(), "deptriagem-model-"));
  try {
    const timeout = (model.seconds ?? (model.effort ? 120 : 90)) * 1000;
    if (model.provider === "opencode-cli") return await runOpenCode(model, prompt, cwd, timeout);
    if (model.provider === "agy") return await runAgy(model, prompt, cwd, timeout, key, responseSchema);
    const modelArgs = model.model ? ["--model", model.model] : [];
    if (model.provider === "claude") {
      const env = runtimeEnv();
      const result = await run("claude", [...(key ? ["--bare"] : []), "--safe-mode", "--print", "--tools", "", "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--permission-mode", "dontAsk",
        "--no-session-persistence", "--output-format", "json", ...modelArgs,
        ...(model.effort ? ["--effort", model.effort] : [])], {
        cwd, timeout, input: prompt, limit: 256 * 1024,
        env: {...env, ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: key ? undefined : process.env.CLAUDE_CONFIG_DIR},
      });
      const output = result.output.toString("utf8");
      if (result.code) throw cliExecutionError("Claude Code", result.diagnostics + output, Boolean(key));
      const response = JSON.parse(output) as {is_error?: boolean; result?: string};
      if (response.is_error) throw cliExecutionError("Claude Code", response.result ?? "", Boolean(key));
      if (typeof response.result !== "string") throw new ModelExecutionError("O Claude Code não retornou uma resposta.");
      return response.result;
    }
    const schemaFile = join(cwd, "schema.json");
    const output = join(cwd, "result.json");
    await writeFile(schemaFile, JSON.stringify(responseSchema), {flag: "wx"});
    const disabled = ["shell_tool", "unified_exec", "shell_snapshot", "multi_agent", "multi_agent_v2",
      "plugins", "hooks", "skill_search", "skill_mcp_dependency_install", "standalone_web_search"];
    const args = ["exec", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "--ephemeral", "--skip-git-repo-check",
      ...disabled.flatMap(feature => ["--disable", feature]), "--output-schema", schemaFile,
      "-o", output, ...modelArgs, ...(model.effort ? ["-c", `model_reasoning_effort="${model.effort}"`] : []), "-"];
    const codex = await codexCommand(args, {...runtimeEnv(), CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: key});
    const result = await run(codex.program, codex.args, {cwd, timeout, env: codex.env, input: prompt, limit: 256 * 1024});
    if (result.code) throw new Error("Codex indisponível.");
    return await readFile(output, "utf8");
  } finally { await rm(cwd, {recursive: true, force: true, maxRetries: 8, retryDelay: 100}); }
}

type Evidence = {languages: Record<string, number>; coverage_issues: string[]; findings_count: number};

async function ask(model: Model, role: "agent" | "reviewer", evidence: Evidence, prior: Check[],
  credentials: Credentials, fallback?: Model, localInventory?: object) {
  const instruction = role === "agent" ? "Selecione verificações defensivas de cobertura de dependências."
    : "Revise de forma independente a cobertura de dependências. A seleção anterior pode estar vazia.";
  const system = instruction + " Responda apenas com o objeto JSON {\"checks\": [\"ID\"]} usando até cinco IDs abaixo.";
  const user = JSON.stringify({evidence: model.provider === "launcher" ? {...evidence, ...localInventory} : evidence,
    previous_checks: prior, available_checks: checks});
  return modelResponse(model, system, user, credentials, schema, "deptriagem_checks", fallback);
}

async function modelResponse(model: Model, system: string, user: string, credentials: Credentials,
  responseSchema: object, name: string, fallback?: Model) {
  const messages = [{role: "system" as const, content: system}, {role: "user" as const, content: user}];
  const key = credential(model.provider, credentials);
  const seconds = model.seconds ?? (model.effort ? 120 : 60);
  const {model: id} = model;
  if (model.provider === "launcher") return chat(messages, {model: id ?? fallback?.model, port: model.port ?? fallback?.port,
    seconds: model.seconds ?? fallback?.seconds, serverThinking: model.effort === "server"},
  {type: "json_schema", json_schema: {name, strict: true, schema: responseSchema}});
  if (["claude", "codex", "opencode-cli", "agy"].includes(model.provider)) {
    return runAgent(model, system + "\n" + user, key, responseSchema);
  }
  if (!key || !id) throw new Error("Modelo ou credencial ausente.");
  if (model.provider === "openai") {
    const result = await post("https://api.openai.com/v1/responses", {Authorization: "Bearer " + key},
      {model: id, store: false, instructions: system, input: user, max_output_tokens: model.effort ? 8192 : 1000,
        ...(model.effort ? {reasoning: {effort: model.effort}} : {}),
        text: {format: {type: "json_schema", name, strict: true, schema: responseSchema}}}, seconds);
    return (result.output ?? []).filter((item: {type: string}) => item.type === "message")
      .flatMap((item: {content: {type: string; text: string}[]}) => item.content)
      .filter((item: {type: string}) => item.type === "output_text").map((item: {text: string}) => item.text).join("");
  }
  if (model.provider === "opencode") {
    const result = await post("https://opencode.ai/zen/v1/chat/completions", {Authorization: "Bearer " + key},
      {model: id, messages, max_tokens: 1000}, seconds);
    return result.choices?.[0]?.message?.content;
  }
  const budget: Record<string, number> = {low: 1024, medium: 4096, high: 8192};
  const thinkingConfig = model.effort ? (/^(?:models\/)?gemini-2\.5/.test(id)
    ? {thinkingBudget: budget[model.effort]} : {thinkingLevel: model.effort.toUpperCase()}) : undefined;
  const result = await post("https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(id.replace(/^models\//, "")) + ":generateContent", {"x-goog-api-key": key}, {
    systemInstruction: {parts: [{text: system}]}, contents: [{role: "user", parts: [{text: user}]}],
    generationConfig: {responseMimeType: "application/json", responseJsonSchema: responseSchema,
      maxOutputTokens: model.effort ? 12288 : 1500, thinkingConfig},
  }, seconds);
  return result.candidates?.[0]?.content?.parts?.filter((part: {thought?: boolean}) => !part.thought)
    .map((part: {text?: string}) => part.text).join("");
}

function modelError(model: Model, error: unknown) {
  if (error instanceof ModelExecutionError) return {detail: error.message};
  if (model.provider !== "launcher") return {};
  if (error instanceof LauncherResponseError) return {reason: error.reason, http_status: error.httpStatus,
    port: error.targetPort, ...(error.reason === "reasoning_only" ? {detail: error.message} : {})};
  return {reason: "invalid"};
}

export async function testModel(model: Model, credentials: Credentials = {}, fallback?: Model) {
  if (model.provider === "off") return {status: "disabled"};
  if (Object.hasOwn(envKeys, model.provider) &&
      !["claude", "agy"].includes(model.provider) && !credential(model.provider, credentials)) {
    return {status: "missing_credential"};
  }
  if (["openai", "opencode", "opencode-cli", "gemini"].includes(model.provider) && !model.model) return {status: "missing_model"};
  try {
    selections(await ask(model, "agent", {languages: {}, coverage_issues: ["no_packages_scanned"], findings_count: 0},
      [], credentials, fallback));
    return {status: "connected"};
  } catch (error) { return {status: "unavailable_or_invalid", ...modelError(model, error)}; }
}

export async function modelGuidance(evidence: Evidence, plan?: ModelPlan, allowExternal = false,
  credentials: Credentials = {}, fallback?: Model, localInventory?: object) {
  const selected = new Set<Check>();
  const roles = [];
  if (plan) for (const role of ["agent", "reviewer"] as const) {
    const model = plan[role];
    if (model.provider === "off") continue;
    let status = "external_not_authorized";
    let proposed: Check[] = [];
    let failure: ReturnType<typeof modelError> = {};
    if (!external(model.provider) || allowExternal) {
      try {
        proposed = selections(await ask(model, role, evidence, [...selected], credentials, fallback, localInventory));
        for (const check of proposed) selected.add(check);
        status = "suggestions";
      } catch (error) { status = "unavailable_or_invalid"; failure = modelError(model, error); }
    }
    roles.push({role, provider: model.provider, effort: model.effort, status, checks: proposed, ...failure});
  }
  return {status: roles.some(role => role.status === "suggestions") ? "suggestions" :
    roles.length ? "unavailable_or_invalid" : "disabled",
  roles, checks: [...selected].map(id => ({id, description: checks[id]}))};
}
