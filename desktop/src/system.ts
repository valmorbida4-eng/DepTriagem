import type {ReportProgress} from "./progress";
import type {ModelPlan} from "./models";
import type {Chat, DeciderConfig} from "./launcher";
import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {constants, createReadStream} from "node:fs";
import {access, mkdir, open, readFile, realpath, rename, rm, stat} from "node:fs/promises";
import {homedir} from "node:os";
import {delimiter, dirname, extname, isAbsolute, join, parse, relative, sep} from "node:path";

const platformDataDir = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
  : process.platform === "win32" ? process.env.LOCALAPPDATA
  : process.env.XDG_DATA_HOME;
export const dataDir = process.env.DEPTRIAGEM_DATA_DIR ||
  join(platformDataDir || join(homedir(), ".local", "share"), "DepTriagem");
export const version = (require("./version.json") as {version: string}).version;
export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function json<T>(path: string): Promise<T> {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as T;
}

export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), {recursive: true});
  const staging = join(dirname(path), ".deptriagem-" + randomUUID());
  try {
    const file = await open(staging, "wx");
    try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); }
    finally { await file.close(); }
    await rename(staging, path);
  } finally { await rm(staging, {force: true}); }
}

export interface Settings {
  catalog_dir?: string;
  scanner?: string;
  reports_dir?: string;
  launcher_models?: Partial<Record<import("./launcher").Role, string>>;
  launcher_reviewer?: Chat;
  theme?: "system" | "light" | "dark" | "Sistema" | "Claro" | "Escuro";
  update_check?: boolean;
  models?: ModelPlan;
  triage_decider?: DeciderConfig;
}
const settingsPath = join(dataDir, "settings.json");
export async function settings(): Promise<Settings> {
  try { return (await json<Settings>(settingsPath)) ?? {}; }
  catch { return {}; }
}
let writingSettings = Promise.resolve();
export function saveSettings(patch: Settings) {
  const operation = writingSettings.then(async () => {
    const value = {...await settings(), ...patch};
    await atomicJson(settingsPath, value);
    return value;
  });
  writingSettings = operation.then(() => undefined, () => undefined);
  return operation;
}

interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; limit?: number; output?: string; input?: string }
export async function resolveExecutable(program: string, env = process.env, cwd?: string) {
  const windows = process.platform === "win32";
  if (isAbsolute(program)) return program;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(program)) throw new Error("Informe um executável por caminho absoluto.");
  const path = Object.entries(env).find(([name]) => windows ? name.toUpperCase() === "PATH" : name === "PATH")?.[1] ?? "";
  const name = windows && !extname(program) ? program + ".exe" : program;
  const current = await realpath(process.cwd()).catch(() => process.cwd());
  const work = cwd && await realpath(cwd).catch(() => cwd);
  const excludedPath = (candidate: string) => {
    if (relative(current, dirname(candidate)) === "") return true;
    if (!work || parse(work).root === work) return false;
    const difference = relative(work, candidate);
    return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(".." + sep));
  };
  for (const item of path.split(delimiter)) {
    const dir = item.trim().replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(dir) || (windows && !/^[a-z]:[/\\]$/i.test(parse(dir).root))) continue;
    const candidate = join(dir, name);
    const physical = await realpath(candidate).catch(() => undefined);
    if (!physical || excludedPath(candidate) || excludedPath(physical) || !(await stat(physical).catch(() => undefined))?.isFile()) continue;
    if (await access(physical, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw new Error(`Não foi possível localizar ${program} nas pastas absolutas do PATH.`);
}

export async function run(program: string, args: string[], options: RunOptions = {}) {
  const executable = await resolveExecutable(program, options.env, options.cwd);
  const env = process.platform === "win32" ? {...(options.env ?? process.env), NoDefaultCurrentDirectoryInExePath: "1"} : options.env;
  const file = options.output ? await open(options.output, "wx") : undefined;
  try {
    return await new Promise<{code: number; output: Buffer; diagnostics: string}>((resolve, reject) => {
      const child = spawn(executable, args, {cwd: options.cwd, env, windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]});
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
      const stdout = child.stdout!;
      const stderr = child.stderr!;
      const chunks: Buffer[] = [];
      const diagnostics: Buffer[] = [];
      let length = 0, errorLength = 0, error: Error | undefined;
      let writing = Promise.resolve();
      const limit = options.limit ?? 12 * 1024 ** 2;
      const stop = (reason: string) => { error ||= new Error(reason); child.kill(); };
      const timer = setTimeout(() => stop("O processo excedeu o tempo permitido."), options.timeout ?? 120_000);
      stdout.on("data", (buffer: Buffer) => {
        length += buffer.length;
        if (length > limit) return stop("A saída excedeu o limite permitido.");
        if (!file) { chunks.push(buffer); return; }
        stdout.pause();
        writing = file.writeFile(buffer).then(() => { stdout.resume(); },
          () => stop("Falha ao gravar o download."));
      });
      stderr.on("data", (buffer: Buffer) => {
        errorLength += buffer.length;
        if (errorLength <= 250_000) diagnostics.push(buffer);
      });
      child.on("error", () => { error ||= new Error(`Não foi possível executar ${program}.`); });
      child.on("close", code => {
        clearTimeout(timer);
        void writing.then(() => {
          if (error) reject(error);
          else resolve({code: code ?? -1, output: Buffer.concat(chunks), diagnostics: Buffer.concat(diagnostics).toString()});
        });
      });
    });
  } finally { await file?.close(); }
}

export async function github<T>(endpoint: string): Promise<T> {
  const result = await run("gh", ["api", "--hostname", "github.com", endpoint]);
  if (result.code) throw new Error("GitHub indisponível ou sem acesso. Confira a conexão e a conta no GitHub CLI.");
  return JSON.parse(result.output.toString()) as T;
}

export async function hashFile(path: string) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

export async function download(url: string, path: string, limit: number,
  progress?: ReportProgress, label = "Recebendo arquivo") {
  progress?.({label});
  const response = await fetch(url, {headers: {"User-Agent": `DepTriagem/${version}`},
    signal: AbortSignal.timeout(180_000)});
  if (!response.ok || !response.body) throw new Error(`Download indisponível (HTTP ${response.status}).`);
  if (new URL(response.url).protocol !== "https:") throw new Error("Download redirecionado para endereço inseguro.");
  const length = Number(response.headers.get("content-length"));
  const encoding = response.headers.get("content-encoding");
  const total = (!encoding || encoding === "identity") && length > 0 ? length : undefined;
  if (length > limit) throw new Error("Download acima do limite permitido.");
  const stream = response.body.getReader();
  const file = await open(path, "wx");
  const digest = createHash("sha256");
  let size = 0, nextUpdate = 0;
  const report = () => progress?.({label, completed: size,
    total: total !== undefined && size <= total ? total : undefined, unit: "bytes"});
  report();
  try {
    while (true) {
      const input = await stream.read();
      if (input.done) break;
      size += input.value.length;
      if (size > limit) throw new Error("Download acima do limite permitido.");
      digest.update(input.value);
      await file.writeFile(input.value);
      if (progress && Date.now() >= nextUpdate) {
        report();
        nextUpdate = Date.now() + 140;
      }
    }
  } finally { await file.close(); await stream.cancel().catch(() => undefined); }
  report();
  return {sha256: digest.digest("hex"), bytes: size, modified: response.headers.get("last-modified")};
}

export function port(input: unknown, fallback?: number) {
  const value = input === "" || input === undefined ? fallback : Number(input);
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("Informe uma porta entre 1 e 65535.");
  }
  return value;
}
