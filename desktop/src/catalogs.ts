import {createHash, randomUUID} from "node:crypto";
import {chmod, mkdir, mkdtemp, rename, rm, stat, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import type {ReportProgress} from "./progress";
import {archive} from "./zip";
import {atomicJson, dataDir, download, hashFile, json, message, run, settings} from "./system";

export const sources = ["npm", "PyPI", "NuGet", "KEV"] as const;
export type Source = typeof sources[number];
const scannerVersion = "2.7.1";
const scannerAssets = {
  "win32-x64": ["osv-scanner_windows_amd64.exe", "7121dcf420aefbbf89a7f0050c4d3094e079ff93afd334dfc96f16b02ec85800"],
  "win32-arm64": ["osv-scanner_windows_arm64.exe", "5f3998b55c9268f8468502bbcb60645038fd5b145ee5e685e6ae2a32e923afc7"],
  "darwin-x64": ["osv-scanner_darwin_amd64", "b8420d5485ba792626315f1bf9a5a2046e971d38eea75bf9090c38852dbc3b1b"],
  "darwin-arm64": ["osv-scanner_darwin_arm64", "b22c02877a811c8f78956e8643efa554932b7378f590d13f8e97d4e9448a29f3"],
  "linux-x64": ["osv-scanner_linux_amd64", "fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8"],
  "linux-arm64": ["osv-scanner_linux_arm64", "983d22fbad9724514e3fcc6acc83b5fa64c5ffa6b0d9f510028f22c1b223ff81"],
} as const;
export const scannerAsset = scannerAssets[(process.platform + "-" + process.arch) as keyof typeof scannerAssets];
const kevUrl = "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json";

export interface Snapshot {
  source: Source; url: string; sha256: string; bytes: number;
  downloaded_at: string; source_updated_at: string | null;
  positive_control?: {advisory: string; scanner_version: string; verified_at: string};
}
export type Kev = {count: number; dateReleased: string; vulnerabilities: {cveID: string}[]};

export function kevIds(kev: Kev) {
  if (!Array.isArray(kev?.vulnerabilities) || !kev.count || kev.vulnerabilities.length !== kev.count ||
      !Number.isFinite(Date.parse(kev.dateReleased))) throw new Error("Catálogo CISA KEV inválido ou incompleto.");
  const ids = new Set(kev.vulnerabilities.map(record => record.cveID));
  if (ids.size !== kev.count || [...ids].some(id => !/^CVE-\d{4}-\d{4,}$/.test(id))) {
    throw new Error("Catálogo CISA KEV com identificadores inválidos.");
  }
  return ids;
}

export async function catalogDir(override?: string) {
  return override || (await settings()).catalog_dir || join(dataDir, "catalogs");
}

const snapshotName = (source: Source, hash: string) => `${source}-${hash}${source === "KEV" ? ".json" : ".zip"}`;

export async function snapshot(root: string, source: Source, verify = false) {
  try {
    const meta = await json<Snapshot>(join(root, `${source}.json`));
    if (meta.source !== source || !/^[a-f0-9]{64}$/.test(meta.sha256)) return null;
    const path = join(root, snapshotName(source, meta.sha256));
    if ((await stat(path)).size !== meta.bytes || (verify && await hashFile(path) !== meta.sha256)) return null;
    return {meta, path};
  } catch { return null; }
}

export async function catalogStatus(directory?: string): Promise<Record<string, Snapshot | null>> {
  const root = await catalogDir(directory);
  return Object.fromEntries(await Promise.all(sources.map(async name => [
    name, (await snapshot(root, name))?.meta ?? null,
  ])));
}

const canaries = {
  npm: ["lodash", "4.17.20", "CVE-2021-23337"],
  PyPI: ["jinja2", "3.1.4", "CVE-2024-56201"],
  NuGet: ["Newtonsoft.Json", "12.0.1", "CVE-2024-21907"],
} as const;

async function positiveControl(source: Exclude<Source, "KEV">, cwd: string, tool: Awaited<ReturnType<typeof scanner>>) {
  const [name, version, advisory] = canaries[source];
  const config = join(cwd, "scanner.toml"), output = join(cwd, "control-result.json");
  await atomicJson(join(cwd, "control.json"), {results: [{packages: [{package: {ecosystem: source, name, version}}]}]});
  await writeFile(config, "# DepTriagem: controle positivo sem supressões.\n", {flag: "wx"});
  const result = await run(tool.executable, ["scan", "source", "--offline", "--no-resolve", "--all-packages", "--format", "json",
    "--config", config, "--lockfile", "osv-scanner:control.json", "--output-file", output], {
    cwd, timeout: 120_000, env: {...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: join(cwd, "db")},
  });
  const failure = () => new Error(`Controle positivo de ${source} falhou: o scanner não retornou ${advisory}.`);
  if (![0, 1].includes(result.code)) throw failure();
  type CanaryPackage = {package?: {ecosystem?: string; name?: string; version?: string};
    vulnerabilities?: {id?: string; aliases?: string[]; withdrawn?: string}[]};
  const data = await json<{results?: {packages?: CanaryPackage[]}[]}>(output).catch(() => null);
  const found = data?.results?.some(entry => entry.packages?.some(item => item.package?.ecosystem === source &&
    item.package.name?.toLowerCase() === name.toLowerCase() && item.package.version === version &&
    item.vulnerabilities?.some(record => !record.withdrawn && (record.id === advisory || record.aliases?.includes(advisory)))));
  if (!found) throw failure();
  return {advisory, scanner_version: tool.version, verified_at: new Date().toISOString()};
}

async function syncOne(root: string, source: Source, tool?: Awaited<ReturnType<typeof scanner>>, progress?: ReportProgress): Promise<Snapshot> {
  await mkdir(root, {recursive: true});
  const temp = await mkdtemp(join(root, ".download-"));
  const path = source === "KEV" ? join(temp, "catalog") : join(temp, "db", "osv-scalibr", source, "all.zip");
  try {
    if (source !== "KEV") await mkdir(dirname(path), {recursive: true});
    const url = source === "KEV" ? kevUrl : `https://osv-vulnerabilities.storage.googleapis.com/${source}/all.zip`;
    const name = source === "KEV" ? "CISA KEV" : "OSV " + source;
    const {sha256, bytes, modified} = await download(url, path, (source === "KEV" ? 10 : 350) * 1024 ** 2,
      progress, "Baixando " + name);
    progress?.({label: "Validando " + name});
    let updated: string | null = modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null;
    let control: Snapshot["positive_control"];
    if (source === "KEV") {
      const data = await json<Kev>(path);
      kevIds(data);
      updated = data.dateReleased;
    } else {
      await archive(path, async (entries, read) => {
        for (const entry of entries.filter(item => item.name.endsWith(".json") && item.size <= 5 * 1024 ** 2).slice(0, 25)) {
          const data = JSON.parse((await read(entry, 5 * 1024 ** 2)).toString());
          if (data.id && data.affected?.some((item: {package?: {ecosystem?: string}}) => item.package?.ecosystem === source)) return;
        }
        throw new Error(`Catálogo OSV ${source} vazio ou incompatível.`);
      });
      progress?.({label: "Executando controle positivo de " + name});
      control = await positiveControl(source, temp, tool!);
      if (await hashFile(path) !== sha256) throw new Error(`O catálogo OSV ${source} mudou durante a validação.`);
    }
    const target = join(root, snapshotName(source, sha256));
    try { await rename(path, target); }
    catch (error) { if (await hashFile(target).catch(() => "") !== sha256) throw error; }
    const meta = {source, sha256, bytes, url, source_updated_at: updated, downloaded_at: new Date().toISOString(),
      ...(control ? {positive_control: control} : {})};
    await atomicJson(join(root, `${source}.json`), meta);
    return meta;
  } finally { await rm(temp, {recursive: true, force: true}); }
}

export async function syncCatalogs(directory?: string, only?: unknown, progress?: ReportProgress, scannerPath?: string): Promise<Record<string,
  ({status: "updated"} & Snapshot) | {status: "failed"; error: string}>> {
  if (only !== undefined && !sources.includes(only as Source)) throw new Error("Fonte de catálogo inválida.");
  const root = await catalogDir(directory);
  const names = only ? [only as Source] : sources;
  let completed = 0;
  const total = names.length;
  let tool: ReturnType<typeof scanner> | undefined;
  progress?.({label: "Atualizando catálogos", completed, total, unit: "items"});
  return Object.fromEntries(await Promise.all(names.map(async name => {
    const report: ReportProgress | undefined = progress && (step => progress({...step, key: name}));
    try {
      const data = await syncOne(root, name, name === "KEV" ? undefined : await (tool ??= scanner(scannerPath)), report);
      report?.({label: name + " atualizado", completed: 1, total: 1});
      return [name, {status: "updated" as const, ...data}] as const;
    } catch (error) {
      report?.({label: "Falha ao atualizar " + name});
      return [name, {status: "failed" as const, error: message(error)}] as const;
    } finally {
      completed++;
      progress?.({label: "Atualizando catálogos", completed, total, unit: "items"});
    }
  })));
}

export async function installScanner(progress?: ReportProgress) {
  if (!scannerAsset) throw new Error("Instale o OSV-Scanner para a arquitetura deste sistema e selecione o execut\u00e1vel.");
  const [scannerName, officialHash] = scannerAsset;
  const folder = join(dataDir, "tools");
  await mkdir(folder, {recursive: true});
  const stage = join(folder, ".scanner-" + randomUUID());
  const target = join(folder, scannerName);
  try {
    const result = await download(`https://github.com/google/osv-scanner/releases/download/v${scannerVersion}/${scannerName}`,
      stage, 100 * 1024 ** 2, progress, "Baixando o OSV-Scanner");
    progress?.({label: "Verificando o SHA-256 do OSV-Scanner"});
    if (result.sha256 !== officialHash) throw new Error("O SHA-256 do OSV-Scanner não confere.");
    if (process.platform !== "win32") await chmod(stage, 0o755);
    await rename(stage, target);
  } finally { await rm(stage, {force: true}); }
  progress?.({label: "OSV-Scanner instalado", completed: 1, total: 1, unit: "steps"});
  return {path: target, version: scannerVersion};
}

export async function scanner(override?: string) {
  const config = override || (await settings()).scanner;
  const managed = scannerAsset && join(dataDir, "tools", scannerAsset[0]);
  const executable = config || (managed && await stat(managed).then(info => info.isFile(), () => false) ? managed : "osv-scanner");
  if (managed && executable === managed && await hashFile(managed) !== scannerAsset[1]) {
    throw new Error("O OSV-Scanner instalado não confere. Reinstale o executável verificado.");
  }
  const result = await run(executable, ["--version"], {timeout: 20_000}).catch(() => {
    throw new Error("Configure ou instale o OSV-Scanner na tela Fontes e ferramentas.");
  });
  const version = result.output.toString().match(/\b2\.\d+\.\d+\b/)?.[0];
  if (result.code || !version) throw new Error("O DepTriagem precisa do OSV-Scanner v2.");
  return {executable, version};
}

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
