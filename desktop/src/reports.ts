import {lstat, mkdir, mkdtemp, rename, rm, writeFile} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {createHash} from "node:crypto";
import type {analyze} from "./projects";

type ProjectReport = Awaited<ReturnType<typeof analyze>>;
const labels: Record<string, string> = {none: "Nenhuma", low: "Baixa", medium: "Média", high: "Alta", critical: "Crítica"};

function markdownText(value: unknown) {
  return String(value ?? "—").replace(/[\x00-\x1f\x7f]/g, " ")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|]/g, "\\$&");
}

export function reportMarkdown(report: Omit<ProjectReport, "model_guidance" | "model_decision">) {
  const lines = ["# Relatório de análise de dependências", "",
    "- Origem " + markdownText(report.source.repository || report.source.directory),
    "- Gerado em " + markdownText(report.generated_at),
    "- OSV-Scanner " + markdownText(report.scanner_version)];
  if (report.source.commit) lines.push("- Commit " + markdownText(report.source.commit));
  lines.push("- Cobertura " + (report.coverage === "partial" ? "parcial" : "inventário verificado"),
    "- Pacotes reportados " + report.packages_reported, "- Achados " + report.findings.length,
    "- CISA KEV " + markdownText(report.kev_status), "", "## Achados", "");
  if (!report.findings.length) lines.push("Nenhum achado no inventário verificado.");
  for (const finding of report.findings) {
    lines.push(`### ${markdownText(finding.name)} ${markdownText(finding.version)}`,
      "- Ecossistema " + markdownText(finding.ecosystem),
      "- Arquivo " + markdownText(finding.source),
      "- Advisories " + finding.ids.map(markdownText).join(", "),
      "- Prioridade " + (finding.priority === "maximum" ? "máxima (CISA KEV)" : "revisão manual"));
    if (finding.severity) lines.push("- Severidade " + markdownText(labels[finding.severity]));
    if (finding.cvss !== null) lines.push("- CVSS base " + markdownText(finding.cvss));
    if (finding.fixed_versions.length) lines.push("- Versões corrigidas publicadas " + finding.fixed_versions.map(markdownText).join(", "));
    if (finding.fix_disagreement) lines.push("- As fontes divergem sobre as versões corrigidas.");
    for (const advisory of finding.advisories) {
      const published = [advisory.published_severity && "severidade publicada " + labels[advisory.published_severity],
        ...advisory.cvss.flatMap(metric => metric.base_score === null ? [] : [metric.type + " base " + metric.base_score]),
        advisory.fixed_versions.length && "correções " + advisory.fixed_versions.join(", ")].filter(Boolean);
      if (published.length) lines.push("  - " + markdownText(advisory.id) + " · " + published.map(markdownText).join(" · "));
    }
    lines.push("");
  }
  if (report.coverage_issues.length) {
    lines.push("", "## Lacunas de cobertura", "");
    for (const issue of report.coverage_issues) lines.push("- " + [issue.reason, issue.ecosystem, issue.path].filter(Boolean).map(markdownText).join(" · "));
  }
  return lines.join("\n").trimEnd() + "\n";
}

export async function exportAnalysis(directory: string, report: ProjectReport) {
  const target = resolve(directory);
  const parent = dirname(target);
  if (target === parent) throw new Error("Escolha uma nova pasta para o relatório.");
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing) throw new Error("A pasta do relatório já existe. Escolha um novo nome.");
  await mkdir(parent, {recursive: true});
  const stage = await mkdtemp(join(parent, ".deptriagem-report-"));
  try {
    const {model_guidance, model_decision, ...official} = report;
    const json = JSON.stringify(official, null, 2) + "\n";
    const digest = createHash("sha256").update(json, "utf8").digest("hex");
    const advisory = Boolean(model_decision || (model_guidance && model_guidance.status !== "disabled"));
    const files = ["relatorio.json", "relatorio.md"];
    await writeFile(join(stage, files[0]), json, {flag: "wx"});
    await writeFile(join(stage, files[1]), reportMarkdown(official), {flag: "wx"});
    if (advisory) {
      files.push("parecer-ia.json");
      await writeFile(join(stage, files[2]), JSON.stringify({
        report: files[0], report_sha256: digest, model_guidance, model_decision,
      }, null, 2) + "\n", {flag: "wx"});
    }
    await rename(stage, target);
    return {directory: target, name: basename(target), files, report_sha256: digest};
  } finally { await rm(stage, {recursive: true, force: true}); }
}
