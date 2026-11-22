import {archive} from "./zip";
import type {Source} from "./catalogs";

const {CVSS40} = require("./vendor/cvss4/cvss40.cjs") as {CVSS40: new (vector: string) => {score: number}};
const levels = ["none", "low", "medium", "high", "critical"] as const;
type Severity = typeof levels[number];
type Package = {name: string; ecosystem: string};
interface Cvss {type: string; vector?: string; base_score: number | null}
export interface Advisory {
  id: string; aliases?: string[]; withdrawn?: string;
  severity?: {type?: string; score?: string | number}[];
  database_specific?: {severity?: string};
  affected?: {package?: Package; ranges?: {type?: string; events?: {fixed?: string}[]}[]}[];
}

const impacts = {N: 0, L: .22, H: .56};
function baseScore(type: string, vector: string): number | null {
  if (type === "CVSS_V4" && vector.startsWith("CVSS:4.0/")) {
    try {
      const base = vector.split("/").slice(0, 12).join("/");
      const {score} = new CVSS40(base);
      return Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
    } catch { return null; }
  }
  const parts = vector.toUpperCase().replace(/^\(|\)$/g, "").replace(/^CVSS:[23]\.[01]\//, "").split("/");
  const entries = parts.map(part => part.split(":"));
  if (entries.some(entry => entry.length !== 2) || new Set(entries.map(entry => entry[0])).size !== entries.length) return null;
  const metrics = Object.fromEntries(entries);
  let invalid = false;
  const weight = (name: string, weights: Record<string, number>) => {
    const value = weights[metrics[name]];
    if (typeof value !== "number") { invalid = true; return 0; }
    return value;
  };
  if (type === "CVSS_V2") {
    const impact = 10.41 * (1 - ["C", "I", "A"].reduce((p, key) => p * (1 - weight(key, {N: 0, P: .275, C: .660})), 1));
    const exploit = 20 * weight("AV", {L: .395, A: .646, N: 1}) *
      weight("AC", {H: .35, M: .61, L: .71}) * weight("AU", {M: .45, S: .56, N: .704});
    if (invalid) return null;
    return impact === 0 ? 0 : Math.round(Math.max(0, Math.min(10, ((.6 * impact) + (.4 * exploit) - 1.5) * 1.176)) * 10) / 10;
  }
  if (type !== "CVSS_V3" || !/^CVSS:3\.[01]\//i.test(vector) || !["U", "C"].includes(metrics.S)) return null;
  const changed = metrics.S === "C";
  const iss = 1 - ["C", "I", "A"].reduce((p, key) => p * (1 - weight(key, impacts)), 1);
  const impact = changed ? 7.52 * (iss - .029) - 3.25 * (iss - .02) ** 15 : 6.42 * iss;
  const exploit = 8.22 * weight("AV", {N: .85, A: .62, L: .55, P: .20}) * weight("AC", {L: .77, H: .44}) *
    weight("PR", changed ? {N: .85, L: .68, H: .50} : {N: .85, L: .62, H: .27}) * weight("UI", {N: .85, R: .62});
  if (invalid) return null;
  const score = Math.min(10, (changed ? 1.08 : 1) * (impact + exploit));
  return impact <= 0 ? 0 : Math.ceil(Math.round(score * 100_000) / 10_000) / 10;
}

function scoreMetrics(record: Advisory): Cvss[] {
  if (!Array.isArray(record.severity)) return [];
  return record.severity.flatMap(metric => {
    const {type, score} = metric ?? {};
    if (typeof type !== "string" || !/^CVSS_V[234]$/.test(type)) return [];
    if (typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10) return [{type, base_score: score}];
    if (typeof score !== "string" || !score || score.length > 400 || /[\x00-\x1f\x7f]/.test(score)) return [];
    const numeric = /^\d+(?:\.\d+)?$/.test(score) ? Number(score) : NaN;
    return [{type, ...(Number.isNaN(numeric) ? {vector: score} : {}),
      base_score: Number.isNaN(numeric) ? baseScore(type, score) : numeric <= 10 ? numeric : null}];
  });
}

function normalizePackage(name: string, ecosystem: string) {
  if (ecosystem === "PyPI") return name.toLowerCase().replace(/[-_.]+/g, "-");
  return ecosystem === "NuGet" ? name.toLowerCase() : name;
}
function advisoryDetails(record: Advisory, target: Package) {
  const cvss = scoreMetrics(record);
  const published = record.database_specific?.severity;
  const label = typeof published === "string" ? published.toLowerCase().replace(/^moderate$/, "medium") : "";
  const publishedRank = levels.indexOf(label as Severity);
  let rank = publishedRank;
  for (const {type, base_score: score} of cvss) if (score !== null) {
    rank = Math.max(rank, score === 0 ? 0 : score < 4 ? 1 : score < 7 ? 2 : score < 9 || type === "CVSS_V2" ? 3 : 4);
  }
  const affected = Array.isArray(record.affected) ? record.affected : [];
  const name = normalizePackage(target.name, target.ecosystem);
  const fixed = affected.flatMap(item => {
    if (item?.package?.ecosystem !== target.ecosystem || typeof item.package.name !== "string" ||
        normalizePackage(item.package.name, target.ecosystem) !== name || !Array.isArray(item.ranges)) return [];
    return item.ranges.flatMap(range => range?.type !== "GIT" && Array.isArray(range?.events)
      ? range.events.flatMap(event => typeof event?.fixed === "string" && event.fixed.trim() &&
        event.fixed.length <= 160 && !/[\x00-\x1f\x7f]/.test(event.fixed) ? [event.fixed.trim()] : []) : []);
  });
  return {id: record.id, severity: levels[rank] ?? null, published_severity: levels[publishedRank] ?? null,
    cvss, fixed_versions: [...new Set(fixed)].sort()};
}

export function findingDetails(records: Advisory[], target: Package) {
  const advisories = [...new Map(records.map(record => [record.id, record])).values()]
    .sort((a, b) => a.id.localeCompare(b.id)).map(record => advisoryDetails(record, target));
  const scores = advisories.flatMap(item => item.cvss.flatMap(metric => metric.base_score === null ? [] : [metric.base_score]));
  const rank = Math.max(-1, ...advisories.map(item => item.severity ? levels.indexOf(item.severity) : -1));
  const fixes = advisories.filter(item => item.fixed_versions.length).map(item => JSON.stringify(item.fixed_versions));
  return {advisories, severity: levels[rank] ?? null, cvss: scores.length ? Math.max(...scores) : null,
    fixed_versions: [...new Set(advisories.flatMap(item => item.fixed_versions))].sort(), fix_disagreement: new Set(fixes).size > 1};
}

export async function cachedAdvisories(catalogs: ReadonlyMap<Source, string>, wanted: ReadonlyMap<Source, Set<string>>) {
  const records = new Map<Source, Map<string, Advisory>>();
  for (const [source, ids] of wanted) {
    const path = catalogs.get(source);
    if (!path || source === "KEV" || !ids.size) continue;
    const selected = new Map<string, Advisory>();
    await archive(path, async (entries, read) => {
      for (const entry of entries) {
        if (!entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(entry.name.lastIndexOf("/") + 1, -5);
        if (!ids.has(id) || selected.has(id)) continue;
        try {
          const item = JSON.parse((await read(entry, 5 * 1024 ** 2)).toString()) as Advisory;
          if (item?.id === id && !item.withdrawn) selected.set(id, item);
        } catch { /* Os metadados do scanner ainda podem estar disponíveis. */ }
      }
    }).catch(() => undefined);
    records.set(source, selected);
  }
  return records;
}
