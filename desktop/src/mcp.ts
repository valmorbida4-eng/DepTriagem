import type {ReportProgress} from "./progress";
import {lstat} from "node:fs/promises";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {join, parse} from "node:path";
import {createInterface} from "node:readline";
import {catalogStatus} from "./catalogs";
import {analyze, repoName, type AnalyzeInput} from "./projects";
import {resolveLocalFolder} from "./git-inventory";
import {atomicJson, dataDir, json, version} from "./system";

const protocols = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const readOnly = {readOnlyHint: true, destructiveHint: false, idempotentHint: true};
const statusTool = {
  name: "catalog_status", description: "Consulta as datas e a disponibilidade dos catálogos OSV e CISA KEV locais.",
  inputSchema: {type: "object", properties: {}, additionalProperties: false},
  annotations: {...readOnly, openWorldHint: false},
};
const scanTool = {
  name: "analyze_dependencies", description: "Verifica dependências do projeto autorizado com OSV-Scanner offline e CISA KEV. O resultado resume achados e cobertura.",
  inputSchema: {type: "object", properties: {}, additionalProperties: false},
};

export async function mcpTarget(root?: string, repo?: string, ref?: string, commit?: string): Promise<AnalyzeInput | undefined> {
  if ((root && repo) || (ref && !repo) || (commit && !root)) {
    throw new Error("Use --root PASTA com --commit opcional ou --github DONO/REPO com --ref opcional.");
  }
  if (repo) return {kind: "github", target: repoName(repo), ref};
  if (!root) return undefined;
  const directory = await resolveLocalFolder(root);
  if (directory === parse(directory).root || !(await lstat(directory)).isDirectory()) {
    throw new Error("Informe uma pasta específica do projeto.");
  }
  return {kind: "local", target: directory, commit};
}

function mcpInvocation(target?: AnalyzeInput) {
  const command = process.execPath;
  const args = [join(__dirname, "cli.js"), "mcp", "serve"];
  if (target?.kind === "local") {
    args.push("--root", target.target);
    if (target.commit) args.push("--commit", target.commit);
  }
  if (target?.kind === "github") {
    args.push("--github", target.target);
    if (target.ref) args.push("--ref", target.ref);
  }
  return {command, args, env: process.versions.electron ? {ELECTRON_RUN_AS_NODE: "1"} : {}};
}

const connectionEnv = "DEPTRIAGEM_MCP_CONNECTION";
function connectionId(host: string, target?: AnalyzeInput) {
  const scope = [host, target?.kind, target?.target, target?.ref];
  if (target?.commit) scope.push(target.commit);
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}
const connectionPath = (id: string) => join(dataDir, "mcp-connections", id + ".json");

export async function mcpConnection(host: string, target?: AnalyzeInput) {
  const receipt = await json<{connectedAt?: unknown}>(connectionPath(connectionId(host, target))).catch(() => null);
  return typeof receipt?.connectedAt === "string" && Number.isFinite(Date.parse(receipt.connectedAt)) ? receipt.connectedAt : null;
}

export function mcpConfig(host: string, target?: AnalyzeInput, verifyConnection = false) {
  const config = mcpInvocation(target);
  const {command, args, env} = config;
  if (verifyConnection) Object.assign(env, {[connectionEnv]: connectionId(host, target)});
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  switch (host) {
    case "codex": return [
      "[mcp_servers.deptriagem]", "command = " + JSON.stringify(command), "args = " + JSON.stringify(args),
      "tool_timeout_sec = 600", ...(Object.keys(env).length ? ["", "[mcp_servers.deptriagem.env]",
        ...Object.entries(env).map(([key, value]) => key + " = " + JSON.stringify(value))] : []),
    ].join("\n");
    case "claude": case "antigravity": return json({mcpServers: {deptriagem: config}});
    case "gemini": return json({mcpServers: {deptriagem: {...config, timeout: 600_000, trust: false}}});
    case "vscode": return json({servers: {deptriagem: {...config, type: "stdio"}}});
    case "opencode": case "opencode-v1": {
      const deptriagem = {type: "local", command: [command, ...args], environment: env, timeout: 600_000};
      return json({mcp: host === "opencode" ? {servers: {deptriagem}} : {deptriagem}});
    }
    default: throw new Error("Use codex, claude, opencode, opencode-v1, gemini, antigravity ou vscode.");
  }
}

type Dictionary = Record<string, unknown>;
type Id = string | number | null;
const object = (value: unknown): value is Dictionary => value !== null && typeof value === "object" && !Array.isArray(value);

export async function testMcp(target?: AnalyzeInput, progress?: ReportProgress) {
  const {command, args, env} = mcpInvocation(target);
  const step = (label: string, completed: number) => progress?.({label, completed, total: 3, unit: "steps"});
  step("Iniciando o servidor MCP", 0);
  const childEnv: NodeJS.ProcessEnv = {...process.env, ...env};
  delete childEnv[connectionEnv];
  const child = spawn(command, args, {env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "ignore"]});
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity, terminal: false});
  const replies = lines[Symbol.asyncIterator]();
  child.stdin.on("error", () => lines.close());
  let failure = "O servidor MCP encerrou antes de responder.";
  child.once("error", () => {
    failure = "Não foi possível iniciar o servidor MCP.";
    lines.close();
  });
  const timeout = setTimeout(() => {
    failure = "O servidor MCP excedeu o tempo de resposta.";
    child.kill();
    lines.close();
  }, 12_000);
  const send = (method: string, id?: number, params?: object) =>
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
  async function response(id: number) {
    const reply = await replies.next();
    if (reply.done) throw new Error(failure);
    const message: unknown = JSON.parse(reply.value);
    if (!object(message) || message.jsonrpc !== "2.0" || message.id !== id || !object(message.result)) {
      throw new Error("Resposta inválida do servidor MCP.");
    }
    return message.result;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error(failure)));
    });
    step("Negociando o protocolo MCP", 1);
    send("initialize", 1, {protocolVersion: protocols[0], capabilities: {},
      clientInfo: {name: "DepTriagem — teste local", version}});
    const {protocolVersion} = await response(1);
    if (typeof protocolVersion !== "string" || !protocols.includes(protocolVersion)) {
      throw new Error("O servidor retornou uma versão de protocolo incompatível.");
    }
    step("Conferindo as ferramentas disponíveis", 2);
    send("notifications/initialized");
    send("tools/list", 2);
    const {tools} = await response(2);
    const expected = target ? [statusTool.name, scanTool.name] : [statusTool.name];
    if (!Array.isArray(tools) || tools.length !== expected.length ||
        !expected.every(name => tools.some(tool => object(tool) && tool.name === name))) {
      throw new Error("As ferramentas do servidor MCP diferem do acesso selecionado.");
    }
    step("Servidor MCP verificado", 3);
    return {protocolVersion, tools: expected};
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

const toolResult = (result: unknown, error = false) => ({
  content: [{type: "text", text: error ? String(result) : JSON.stringify(result)}],
  ...(error ? {isError: true} : {}),
});

export async function serveMcp(target?: AnalyzeInput) {
  const input = createInterface({input: process.stdin, crlfDelay: Infinity, terminal: false});
  const active = new Set<Promise<void>>();
  let state: "new" | "initializing" | "ready" = "new";
  const receipt = process.env[connectionEnv];
  let analyzing = false;
  const jobs = new Map<Id, {cancelled: boolean}>();
  let disconnected = false;
  const disconnect = () => {
    disconnected = true;
    input.close();
    process.stdin.pause();
  };
  process.stdout.on("error", disconnect);
  function write(payload: object): Promise<void> {
    if (disconnected) return Promise.resolve();
    return new Promise(resolve => {
      process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...payload}) + "\n", error => {
        if (error) disconnect();
        resolve();
      });
    });
  }
  const send = (id: Id, payload: object) => write({id, ...payload});
  const fail = (id: Id, code: number, message: string) => send(id, {error: {code, message}});
  async function handle(line: string) {
    let request: unknown;
    if (line.length > 256 * 1024) return fail(null, -32600, "Request too large");
    try { request = JSON.parse(line); }
    catch { return fail(null, -32700, "Parse error"); }
    if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return fail(null, -32600, "Invalid request");
    }
    const {id, method, params} = request;
    if (id === undefined) {
      if (method === "notifications/initialized" && state === "initializing") {
        state = "ready";
        if (receipt && /^[a-f0-9]{64}$/.test(receipt)) {
          await atomicJson(connectionPath(receipt), {connectedAt: new Date().toISOString()}).catch(() => undefined);
        }
      }
      if (method === "notifications/cancelled" && object(params)) {
        const job = jobs.get(params.requestId as Id);
        if (job) job.cancelled = true;
      }
      return;
    }
    if (typeof id !== "string" && typeof id !== "number" && id !== null) return fail(null, -32600, "Invalid request id");
    if (method === "ping") return send(id, {result: {}});
    if (method === "initialize") {
      if (state !== "new" || !object(params) || typeof params.protocolVersion !== "string") {
        return fail(id, -32602, "Invalid initialization");
      }
      state = "initializing";
      const protocolVersion = protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0];
      return send(id, {result: {protocolVersion, serverInfo: {name: "deptriagem", version}, capabilities: {tools: {}}}});
    }
    if (state !== "ready") return fail(id, -32002, "Server not initialized");
    if (method === "tools/list") {
      const tools = target ? [statusTool, {...scanTool, annotations: {...readOnly, openWorldHint: target.kind === "github"}}] : [statusTool];
      return send(id, {result: {tools}});
    }
    if (method !== "tools/call") return fail(id, -32601, "Method not found");
    if (!object(params) || (params.arguments !== undefined && (!object(params.arguments) ||
      Object.keys(params.arguments).length > 0))) return fail(id, -32602, "Invalid tool arguments");
    if (params.name === "catalog_status") {
      try { return await send(id, {result: toolResult(await catalogStatus())}); }
      catch { return send(id, {result: toolResult("Falha ao consultar os catálogos locais.", true)}); }
    }
    if (params.name !== "analyze_dependencies" || !target) return fail(id, -32602, "Unknown tool");
    if (analyzing) return send(id, {result: toolResult("Há uma análise em andamento neste servidor.", true)});
    analyzing = true;
    const job = {cancelled: false};
    jobs.set(id, job);
    try {
      if (target.kind === "local" && (await resolveLocalFolder(target.target)) !== target.target) throw new Error("Project moved");
      const progressToken = object(params._meta) ? params._meta.progressToken : undefined;
      let previous = -1;
      const progress: ReportProgress | undefined =
        typeof progressToken === "string" || typeof progressToken === "number" ? step => {
          if (!job.cancelled && step.completed !== undefined && step.completed > previous) {
            previous = step.completed;
            void write({method: "notifications/progress", params: {
              progressToken, progress: step.completed, total: step.total, message: step.label,
            }});
          }
        } : undefined;
      const report = await analyze(target, progress);
      const ordered = [...report.findings.filter(item => item.priority === "maximum"),
        ...report.findings.filter(item => item.priority !== "maximum")];
      const findings = ordered.slice(0, 60).map(({source: _source, name, version, ecosystem, ids, kev, priority}) =>
        ({name: name.slice(0, 240), version: version.slice(0, 120), ecosystem: ecosystem.slice(0, 48),
          ids: ids.slice(0, 20).map(value => value.slice(0, 120)), kev: kev.slice(0, 20).map(value => value.slice(0, 120)), priority}));
      const coverage = [...new Set(report.coverage_issues.map(issue => issue.reason))];
      if (!job.cancelled) await send(id, {result: toolResult({
        packages_reported: report.packages_reported, coverage: report.coverage, coverage_issues: coverage,
        kev_status: report.kev_status, kev_date: report.kev_date, findings_count: report.findings.length,
        findings_truncated: findings.length < report.findings.length, findings,
      })});
    } catch {
      if (!job.cancelled) await send(id, {result: toolResult("A análise falhou. Verifique o OSV-Scanner, a origem e o perfil do DepTriagem.", true)});
    } finally {
      jobs.delete(id);
      analyzing = false;
    }
  }
  for await (const line of input) {
    if (active.size >= 16) await Promise.race(active);
    const task = handle(line).finally(() => { active.delete(task); });
    active.add(task);
  }
  await Promise.all(active);
  process.stdout.off("error", disconnect);
}
