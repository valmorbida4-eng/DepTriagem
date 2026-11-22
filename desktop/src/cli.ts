import {monitorStatus} from "./monitor";
import type {ReportProgress} from "./progress";
import {parseArgs} from "node:util";
import {resolve} from "node:path";
import {writeFile} from "node:fs/promises";
import {analyze, account, readRelato, repositories, review} from "./projects";
import {exportAnalysis} from "./reports";
import {catalogStatus, installScanner, syncCatalogs} from "./catalogs";
import {deciderConfig, defaultChatSeconds} from "./launcher";
import {mcpConfig, mcpTarget, serveMcp} from "./mcp";
import {listModels, modelConfig, testModel, triageWithModel} from "./models";
import {atomicJson, message, port, version} from "./system";
import {checkUpdate, fetchUpdate, lastInstall, launchVerifiedUpdate} from "./updates";
import {migratePreviousProfile} from "./migration";

const help = `DepTriagem ${version}

  analyze --local PASTA [--commit REFERÊNCIA] [--output ARQUIVO | --report-dir NOVA_PASTA]
  analyze --github DONO/REPO [--ref REFERÊNCIA] [--output ARQUIVO | --report-dir NOVA_PASTA]
  review RELATORIO_OSV --kev CATALOGO_KEV
  triage RELATO.txt [--decider PROVEDOR] [--decider-port PORTA] [--decider-model ID] [--decider-effort ESFORÇO] [--allow-external] [--note ARQUIVO]
  catalogs status|update [--source npm|PyPI|NuGet|KEV]
  mcp serve [--root PASTA [--commit REFERÊNCIA] | --github DONO/REPO [--ref BRANCH]]
  mcp config CLIENTE [--root PASTA [--commit REFERÊNCIA] | --github DONO/REPO [--ref BRANCH]]
  models list --agent codex|claude|opencode-cli|agy
  models test --agent PROVEDOR [--agent-model ID] [--agent-effort ESFORÇO] [--agent-port PORTA]
  scanner-install
  github status|repos
  monitor status
  update check|download|install|status [--directory PASTA]

Opções de análise: --scanner, --catalog-dir, --model-guidance,
--chat-port, --chat-model e --chat-timeout.
--agent e --reviewer selecionam launcher|openai|codex|claude|opencode-cli|agy|opencode|gemini|off.
--decider seleciona systemone|chat|codex|claude|opencode|opencode-local|agy|openai|opencode-zen|gemini.
Na análise, --decider é opcional e sugere uma fila para revisão dos resultados.
Use --agent-model, --reviewer-model, --agent-effort ou --reviewer-effort
e --agent-port ou --reviewer-port
para configurar cada papel e --allow-external para autorizar o resumo externo.
Use --progress para receber eventos de andamento em JSON no stderr.
`;

export async function main(args: string[]) {
  const {values, positionals: [command, action, client]} = parseArgs({
    args, allowPositionals: true,
    options: {
      help: {type: "boolean", short: "h"}, version: {type: "boolean"}, progress: {type: "boolean"},
      root: {type: "string"}, local: {type: "string"}, github: {type: "string"}, ref: {type: "string"}, output: {type: "string"},
      commit: {type: "string"}, "report-dir": {type: "string"},
      scanner: {type: "string"}, "catalog-dir": {type: "string"}, "model-guidance": {type: "boolean"},
      agent: {type: "string"}, reviewer: {type: "string"}, "allow-external": {type: "boolean"},
      "agent-model": {type: "string"}, "reviewer-model": {type: "string"},
      "agent-effort": {type: "string"}, "reviewer-effort": {type: "string"},
      "agent-port": {type: "string"}, "reviewer-port": {type: "string"},
      "chat-port": {type: "string"}, "chat-model": {type: "string"}, "chat-timeout": {type: "string"},
      decider: {type: "string"}, "decider-port": {type: "string"}, "decider-model": {type: "string"}, "decider-effort": {type: "string"},
      threshold: {type: "string"}, note: {type: "string"},
      kev: {type: "string"}, "max-kev-age": {type: "string"}, source: {type: "string"}, directory: {type: "string"},
    },
  });
  const progress: ReportProgress | undefined = values.progress ? step => console.error(JSON.stringify(step)) : undefined;
  const print = (data: unknown) => { console.log(JSON.stringify(data, null, 2)); };
  if (values.version) { console.log(`deptriagem ${version}`); return 0; }
  if (values.help || !command) { console.log(help.trim()); return 0; }
  if (["analyze", "catalogs", "scanner-install"].includes(command) || (command === "mcp" && action === "serve")) {
    await migratePreviousProfile().catch(() => {
      console.error("A migração do perfil anterior ficou incompleta. Serão usadas as configurações atuais.");
    });
  }
  if (command === "mcp") {
    if (action !== "serve" && action !== "config") throw new Error("Use mcp serve ou mcp config CLIENTE.");
    if ((action === "serve" && client) || values.local) throw new Error("Use --root para definir a pasta do projeto.");
    const target = await mcpTarget(values.root, values.github, values.ref, values.commit);
    if (action === "config") console.log(mcpConfig(client, target));
    else await serveMcp(target);
    return 0;
  }
  const chat = {port: port(values["chat-port"], 8080), model: values["chat-model"] || "modelo-local",
    seconds: Number(values["chat-timeout"] || defaultChatSeconds)};
  const choice = (role: "agent" | "reviewer") => {
    const selectedPort = values[`${role}-port` as const];
    return modelConfig({
      provider: values[role], model: values[`${role}-model` as const], effort: values[`${role}-effort` as const],
      port: selectedPort === undefined ? undefined : port(selectedPort),
      seconds: values["chat-timeout"] === undefined ? undefined : chat.seconds,
    }, role === "agent" && values["model-guidance"] ? "launcher" : "off");
  };
  const deciderChoice = () => deciderConfig({mode: values.decider ?? "systemone",
    port: values["decider-port"] === undefined ? undefined : port(values["decider-port"]),
    model: values["decider-model"], effort: values["decider-effort"]});
  switch (command) {
    case "models": {
      if (!values.agent || !["list", "test"].includes(action) || values.agent === "off") {
        throw new Error("Use models list ou models test com --agent PROVEDOR.");
      }
      if (action === "list") {
        const result = await listModels(choice("agent").provider);
        print(result);
        return result.models.length ? 0 : 2;
      }
      const result = await testModel(choice("agent"), {}, {provider: "launcher", ...chat});
      print(result);
      return result.status === "connected" ? 0 : 2;
    }
    case "analyze": {
      if (Boolean(values.local) === Boolean(values.github) || (values.ref && !values.github)) {
        throw new Error("Informe uma pasta local ou um repositório GitHub. --ref é exclusivo do GitHub.");
      }
      if (values.commit !== undefined && (!values.local || !values.commit.trim())) throw new Error("Use --commit com uma referência Git e --local.");
      if (values.output !== undefined && values["report-dir"] !== undefined) throw new Error("Escolha --output ou --report-dir.");
      const data = await analyze({kind: values.github ? "github" : "local", target: values.github || values.local!,
        ref: values.ref, commit: values.commit?.trim(), scanner: values.scanner, catalog_dir: values["catalog-dir"],
        guidance: values["model-guidance"] || values.agent || values.reviewer ? chat : undefined,
        models: values.agent || values.reviewer ? {agent: choice("agent"), reviewer: choice("reviewer")} : undefined,
        decider: values.decider ? deciderChoice() : undefined,
        allowExternal: values["allow-external"]}, progress);
      if (values.output) await atomicJson(resolve(values.output), data);
      else if (values["report-dir"]) print(await exportAnalysis(values["report-dir"], data));
      else print(data);
      return data.coverage === "partial" ? 2 : data.findings.length ? 1 : 0;
    }
    case "review": {
      if (!action || !values.kev) throw new Error("Informe o relatório OSV e --kev.");
      const data = await review(action, values.kev, Number(values["max-kev-age"] || 14));
      print(data);
      return !data.packages_reported || data.kev_status !== "current" ? 2 : 0;
    }
    case "triage": {
      if (!action) throw new Error("Informe o arquivo de relato.");
      const decider = deciderChoice();
      const noteConfig = decider.mode === "chat" || decider.mode === "opencode-local" ? {...chat, port: Number(values["chat-port"] || decider.port || 8080),
        model: values["chat-model"] || decider.model || chat.model} : chat;
      const result = await triageWithModel(await readRelato(action), decider, Number(values.threshold || .8),
        values.note ? noteConfig : undefined, values["allow-external"]);
      const {note, ...data} = result;
      if (note && values.note) await writeFile(values.note, "Parecer de IA para revisão humana\n\n" + note + "\n", {flag: "wx"});
      print(data);
      return result.reason === "decider_unavailable" || result.reason === "external_not_authorized" || result.note_unavailable ? 2 : 0;
    }
    case "catalogs": {
      if (action === "status") print(await catalogStatus(values["catalog-dir"]));
      else if (action === "update") {
        const data = await syncCatalogs(values["catalog-dir"], values.source, progress, values.scanner);
        print(data);
        return Object.values(data).some(item => item.status === "failed") ? 1 : 0;
      } else throw new Error("Use catalogs status ou catalogs update.");
      return 0;
    }
    case "scanner-install": print(await installScanner(progress)); return 0;
    case "monitor": {
      if (action !== "status") throw new Error("Use monitor status.");
      const {config, next, runs} = await monitorStatus();
      print({config, next, runs});
      return 0;
    }
    case "github":
      if (action === "status") print({account: await account()});
      else if (action === "repos") print(await repositories());
      else throw new Error("Use github status ou github repos.");
      return 0;
    case "update": {
      if (action === "status") { print(await lastInstall()); return 0; }
      if (!["check", "download", "install"].includes(action || "")) throw new Error("A\u00e7\u00e3o de atualiza\u00e7\u00e3o inv\u00e1lida.");
      const update = await checkUpdate();
      if (action === "check") { print(update); return 0; }
      if (action === "install" && (process.platform !== "win32" || !process.versions.electron)) {
        throw new Error("Para instalar, execute a CLI da c\u00f3pia instalada com a janela do DepTriagem fechada.");
      }
      const path = await fetchUpdate(update, values.directory ? resolve(values.directory) : undefined, progress);
      if (action === "install") {
        await launchVerifiedUpdate(path, process.execPath, update.sha256!, update.version!, false);
        print({status: "pending", version: update.version, download: path});
      } else print({...update, download: path});
      return 0;
    }
    default: throw new Error("Comando desconhecido. Use --help.");
  }
}
void main(process.argv.slice(2)).then(code => {process.exitCode = code;},
  error => {console.error(message(error)); process.exitCode = 2;});
