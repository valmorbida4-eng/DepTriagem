import {randomUUID} from "node:crypto";
import {stat} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {account, analyze, repositories, repoName} from "./projects";
import {catalogStatus, syncCatalogs, sources} from "./catalogs";
import {atomicJson, dataDir, json, settings} from "./system";
import {periods, type Period, type MonitorConfig, type MonitorRun, type MonitorStatus} from "./monitor-types";
import type {ReportProgress} from "./progress";

const directory = join(dataDir, "monitor");
const configFile = join(directory, "schedule.json");
const stateFile = join(directory, "history.json");
type Finding = Awaited<ReturnType<typeof analyze>>["findings"][number];
interface FindingKeys {aliases: string[]; key: string; priority: string}
interface History {
  schedule?: string;
  lastStart?: string;
  refreshed?: string;
  runs: MonitorRun[];
  baseline: Record<string, FindingKeys[]>;
}

async function stored<T>(path: string, fallback: T) {
  try { return await json<T>(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("Falha ao ler os dados locais do monitoramento.");
  }
}

const defaultRefreshHours = 24;
const hour = 3_600_000;
const validRefreshHours = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && Number.isSafeInteger(value * hour);

async function loadConfig(): Promise<MonitorConfig | null> {
  const config = await stored<Omit<MonitorConfig, "refreshHours"> & {refreshHours?: number} | null>(configFile, null);
  return config && {...config, refreshHours: validRefreshHours(config.refreshHours) ? config.refreshHours : defaultRefreshHours};
}
const loadHistory = () => stored<History>(stateFile, {runs: [], baseline: {}});
let running = false;
let saving = false;

export function nextRun(start: string, period: Period, lastStart?: string) {
  const anchor = new Date(start);
  if (!lastStart) return anchor;
  const last = new Date(lastStart);
  if (last < anchor) return anchor;
  if (period === "hourly") {
    return new Date(anchor.getTime() + (Math.floor((last.getTime() - anchor.getTime()) / hour) + 1) * hour);
  }
  if (period === "monthly") {
    const month = (last.getFullYear() - anchor.getFullYear()) * 12 + last.getMonth() - anchor.getMonth();
    const at = (offset: number) => {
      const date = new Date(anchor);
      date.setDate(1);
      date.setMonth(date.getMonth() + offset);
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(Math.min(anchor.getDate(), end));
      return date;
    };
    const proposed = at(month);
    return proposed > last ? proposed : at(month + 1);
  }
  const step = period === "weekly" ? 7 : 1;
  const calendar = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const slots = Math.floor((calendar(last) - calendar(anchor)) / (86_400_000 * step));
  const date = new Date(anchor);
  date.setDate(anchor.getDate() + slots * step);
  if (date <= last) date.setDate(date.getDate() + step);
  return date;
}

export async function saveMonitor(input: Record<string, unknown>) {
  if (running || saving) throw new Error("Aguarde a opera\u00e7\u00e3o de monitoramento em andamento.");
  saving = true;
  try {
    const old = await loadConfig();
    if (input.enabled === false && old) {
      await atomicJson(configFile, {...old, enabled: false});
      return;
    }
    const scope = input.scope;
    const period = input.period as Period;
    const start = new Date(typeof input.start === "string" ? input.start : "");
    if ((scope !== "all" && scope !== "selected") || !periods.includes(period) ||
        !Number.isFinite(start.getTime())) throw new Error("Selecione escopo, frequ\u00eancia e in\u00edcio.");
    const refreshHours = input.refreshHours ?? old?.refreshHours ?? defaultRefreshHours;
    if (!validRefreshHours(refreshHours)) throw new Error("Informe o intervalo dos catálogos em horas inteiras, a partir de 1.");
    const values = Array.isArray(input.repos) ? input.repos : [];
    const repos = scope === "selected" ?
      [...new Set(values.map(item => repoName(typeof item === "string" ? item : "")))].sort() : [];
    if (scope === "selected" && !repos.length) throw new Error("Selecione ao menos um reposit\u00f3rio.");
    const login = await account();
    const config: MonitorConfig = {id: randomUUID(), enabled: true, login, scope, repos,
      period, start: start.toISOString(), refresh: input.refresh === true, refreshHours};
    await atomicJson(configFile, config);
  } finally { saving = false; }
}

export function compareFindings(findings: Finding[], previous: FindingKeys[], partial: boolean) {
  const keys = findings.map(item => ({
    key: JSON.stringify([item.ecosystem, item.name, item.source]), aliases: item.ids, priority: item.priority,
  }));
  const indexed = (items: FindingKeys[]) => {
    const index = new Map<string, Set<string>>();
    for (const item of items) {
      if (!index.has(item.key)) index.set(item.key, new Set());
      for (const alias of item.aliases) index.get(item.key)!.add(alias);
    }
    return index;
  };
  const old = indexed(previous);
  const oldPriority = indexed(previous.filter(item => item.priority === "maximum"));
  const overlaps = (item: FindingKeys, index: ReturnType<typeof indexed>) =>
    item.aliases.some(alias => index.get(item.key)?.has(alias));
  const added = findings.filter((_item, index) =>
    !overlaps(keys[index], keys[index].priority === "maximum" ? oldPriority : old));
  const current = indexed(keys);
  const baseline = partial ? keys.concat(previous.filter(item => !overlaps(item, current))) : keys;
  return {added, baseline};
}

export async function monitorStatus(): Promise<MonitorStatus> {
  const [config, history] = await Promise.all([loadConfig(), loadHistory()]);
  const next = config?.enabled ? nextRun(config.start, config.period,
    history.schedule === config.id ? history.lastStart : undefined).toISOString() : null;
  return {config, next, running, runs: history.runs};
}

export async function runMonitor(manual = false, progress?: ReportProgress): Promise<MonitorRun | null> {
  if (running || saving) return null;
  running = true;
  try {
    const [config, history, preferences] = await Promise.all([loadConfig(), loadHistory(), settings()]);
    if (!config || (!manual && !config.enabled)) return null;
    const due = nextRun(config.start, config.period, history.schedule === config.id ? history.lastStart : undefined);
    const started = new Date();
    if (!manual && started < due) return null;
    const run: MonitorRun = {id: randomUUID(), started: started.toISOString(), repos: [], warnings: []};
    if (!manual || (config.enabled && started >= due)) {
      history.schedule = config.id;
      history.lastStart = run.started;
    }
    history.runs = [run, ...history.runs].slice(0, 25);
    await atomicJson(stateFile, history);
    try {
      progress?.({label: "Verificando a conta do GitHub"});
      const session = config.scope === "all" ? await repositories() : {login: await account(), repos: config.repos};
      if (session.login.toLowerCase() !== config.login.toLowerCase()) {
        throw new Error("A conta do GitHub mudou. Salve novamente o agendamento com a conta atual.");
      }
      const refreshInterval = config.refreshHours * hour;
      const now = started.getTime();
      const lastAttempt = Date.parse(history.refreshed ?? "");
      if (config.refresh && (!Number.isFinite(lastAttempt) || now - lastAttempt >= refreshInterval)) {
        history.refreshed = run.started;
        const status = await catalogStatus(preferences.catalog_dir);
        for (const source of sources) {
          const timestamp = status[source]?.downloaded_at;
          if (timestamp && now - Date.parse(timestamp) < refreshInterval) continue;
          const result = await syncCatalogs(preferences.catalog_dir, source, progress && (step =>
            progress({...step, key: "catalog-" + source})));
          if (result[source]?.status !== "updated") run.warnings.push("Falha ao atualizar " + source + ". Foi usada a c\u00f3pia local, se dispon\u00edvel.");
        }
      }
      const names = [...new Set(session.repos.map(repoName))];
      if (!names.length) run.warnings.push("Nenhum reposit\u00f3rio localizado para a conta.");
      const reportRoot = preferences.reports_dir || join(dataDir, "reports");
      if (!isAbsolute(reportRoot) || (preferences.reports_dir && !(await stat(reportRoot).catch(() => undefined))?.isDirectory())) throw new Error("Configure uma pasta de relat\u00f3rios v\u00e1lida.");
      for (const [index, repo] of names.entries()) {
        progress?.({label: "Verificando " + repo, completed: index, total: names.length, unit: "repos"});
        try {
          const result = await analyze({kind: "github", target: repo, expectedAccount: config.login});
          const key = config.login.toLowerCase() + "/" + repo.toLowerCase();
          const partial = result.coverage === "partial";
          const changes = compareFindings(result.findings, history.baseline[key] ?? [], partial);
          const [owner, name] = repo.split("/");
          const report = join(reportRoot, "monitoramento", run.id, "owner-" + owner, "repo-" + name + ".json");
          await atomicJson(report, {...result, monitoring: {run_id: run.id, new_findings: changes.added}});
          history.baseline[key] = changes.baseline;
          run.repos.push({repo, report, findings: result.findings.length, added: changes.added.length, partial});
        } catch {
          run.repos.push({repo, error: "Falha na an\u00e1lise ou ao gravar o relat\u00f3rio."});
        }
        await atomicJson(stateFile, history);
      }
      progress?.({label: "Monitoramento finalizado", completed: names.length, total: names.length, unit: "repos"});
    } catch (error) {
      run.warnings.push(error instanceof Error ? error.message : "Falha no monitoramento.");
    }
    run.finished = new Date().toISOString();
    await atomicJson(stateFile, history);
    return run;
  } finally { running = false; }
}

export async function monitorReport(id: unknown, repo: unknown) {
  return (await loadHistory()).runs.find(run => run.id === id)?.repos.find(item => item.repo === repo)?.report;
}
