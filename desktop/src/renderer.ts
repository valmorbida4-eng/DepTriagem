type Progress = import("./progress").Progress;

const launcherRoles = ["chat", "decider", "reviewer"] as const;
type Role = typeof launcherRoles[number];
type Theme = "system" | "light" | "dark";
type Page = "projects" | "monitor" | "review" | "triage" | "launcher" | "settings" | "preferences" | "models" | "mcp" | "updates";
interface Server {model_id: string; port: number; host?: string; api_model?: string}
interface LauncherState {
  models: {role: Role; id: string; name: string}[];
  servers: Record<"chat" | "decider", Server | null> & {reviewer?: Server | null};
}
interface Report {
  packages_reported: number;
  findings: {name: string; version: string; ids: string[]; priority: string; severity?: string | null; cvss?: number | null;
    fixed_versions?: string[]; fix_disagreement?: boolean;
    advisories?: {id: string; fixed_versions: string[]}[]}[];
  coverage?: string;
  coverage_issues?: {reason: string; path?: string; ecosystem?: string}[];
  source?: {directory?: string; repository?: string; commit?: string};
  model_guidance?: {status: string; checks?: {description: string}[];
    reviewer_launcher?: {source: "dedicated" | "primary"; model: string; port: number};
    roles?: ({role: ModelRole; provider: string} & ModelOutcome)[]};
  model_decision?: {queue: string; reason: string; detail?: string};
}
interface Catalog {source_updated_at: string; downloaded_at: string;
  positive_control?: {advisory: string; scanner_version: string; verified_at: string}}
interface UpdateInfo {status: string; version?: string; notes?: string; published_at?: string}

function field<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("Controle indisponível: " + id);
  return node as T;
}
const value = (id: string) => field<HTMLInputElement>(id).value.trim();
const checked = (id: string) => field<HTMLInputElement>(id).checked;
function numeric(id: string) {
  const input = value(id);
  return input ? Number(input) : undefined;
}
function progressText({label, completed, total, unit}: Progress) {
  if (completed === undefined) return label;
  const format = new Intl.NumberFormat("pt-BR", {maximumFractionDigits: 1});
  const bytes = (value: number) => value >= 1024 ** 2 ? format.format(value / 1024 ** 2) + " MiB"
    : value >= 1024 ? format.format(value / 1024) + " KiB" : format.format(value) + " B";
  const count = unit === "bytes" ? bytes : format.format;
  const suffix = unit === "steps" ? " etapas concluídas" : unit === "items" ? " fontes processadas" : unit === "bytes" ? " recebidos" : unit === "repos" ? " reposit\u00f3rios processados" : "";
  return label + " · " + count(completed) + (total ? " / " + count(total) : "") + suffix;
}

const operationLabels: Record<string, string> = {
  "monitor:run": "Verificando reposit\u00f3rios do GitHub",
  "project:analyze": "Analisando depend\u00eancias",
  "catalog:sync": "Atualizando cat\u00e1logos",
  "catalog:install": "Instalando o OSV-Scanner",
  "update:check": "Consultando releases",
  "update:download": "Preparando a atualiza\u00e7\u00e3o",
  "launcher:control": "Aguardando o Launcher",
  "model:test": "Testando o modelo com dados fict\u00edcios",
  "mcp:test": "Testando o servidor MCP local",
  "triage:test": "Testando o Decisor com dados fictícios",
  "triage:run": "Classificando o relato",
};
const operations = new Map<string, HTMLElement>();
let nextOperation = 0;
function showProgress(id: string, value: Progress) {
  const panel = operations.get(id);
  if (!panel) return;
  const key = value.key ?? "";
  let row = [...panel.querySelectorAll<HTMLElement>("[data-key]")].find(item => item.dataset.key === key);
  if (!row) {
    row = document.createElement("div");
    row.dataset.key = key;
    row.append(document.createElement("span"), document.createElement("progress"));
    panel.append(row);
  }
  const text = value.unit ? progressText(value) : value.label;
  row.querySelector("span")!.textContent = text;
  const bar = row.querySelector("progress")!;
  bar.setAttribute("aria-label", value.label);
  bar.setAttribute("aria-valuetext", text);
  if (value.total !== undefined && value.total > 0 && value.completed !== undefined) {
    bar.max = value.total;
    bar.value = value.completed;
  } else bar.removeAttribute("value");
}
window.deptriagem.onProgress(showProgress);
async function invoke<T>(channel: string, data?: object) {
  const label = operationLabels[channel];
  const id = label && String(++nextOperation);
  if (id) {
    const card = document.createElement("article");
    card.className = "operation";
    operations.set(id, card);
    const panel = field("operations");
    panel.append(card);
    panel.hidden = false;
    showProgress(id, {label});
  }
  try {
    const result = await window.deptriagem.invoke<T>(channel, id ? {...data, progressId: id} : data);
    if (!result.ok) throw new Error(result.message);
    return result.data;
  } finally {
    if (id) {
      operations.get(id)?.remove();
      operations.delete(id);
      field("operations").hidden = operations.size === 0;
    }
  }
}
function setStatus(content: string, error = false) {
  field("status").textContent = content;
  field("status").dataset.error = String(error);
}
function act(id: string, handler: () => Promise<void>) {
  const button = field<HTMLButtonElement>(id);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error), true); }
    finally { button.disabled = false; repaintControls(); }
  });
}
function setText(id: string, text: string, error = false) {
  const element = field(id);
  element.textContent = text;
  if (error) element.dataset.error = "true";
  else delete element.dataset.error;
}
const groups: Record<string, Page[]> = {
  analysis: ["projects", "monitor", "review", "triage"], launcher: ["launcher"], settings: ["settings", "preferences", "models", "mcp", "updates"],
};
const active: Record<string, Page> = {analysis: "projects", launcher: "launcher", settings: "settings"};
function showPage(page: Page) {
  const group = Object.keys(groups).find(name => groups[name].includes(page));
  if (!group) return;
  active[group] = page;
  document.querySelectorAll<HTMLElement>(".view").forEach(view => { view.hidden = view.id !== "page-" + page; });
  field("analysis-nav").hidden = group !== "analysis";
  field("settings-nav").hidden = group !== "settings";
  document.querySelectorAll<HTMLElement>("[data-group], nav [data-page]").forEach(node => {
    if (node.dataset.group === group || node.dataset.page === page) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  if (page === "launcher") void refreshLauncher();
  if (page === "projects") refreshAnalysisChoices(false);
  if (page === "triage") refreshTriageSelection();
  if (page === "monitor") void refreshMonitor().catch(error => setStatus(error.message, true));
  window.scrollTo(0, 0);
}
document.querySelectorAll<HTMLButtonElement>("[data-group], [data-page]").forEach(button => {
  button.addEventListener("click", () => showPage((button.dataset.page as Page) || active[button.dataset.group || "analysis"]));
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pick]")) {
  button.addEventListener("click", async () => {
    try {
      const selected = await invoke<string | null>("app:pick", {type: button.dataset.pick});
      if (selected) {
        const input = field<HTMLInputElement>(button.dataset.target!);
        input.value = selected;
        input.dispatchEvent(new Event("input"));
      }
    } catch (error) { setStatus((error as Error).message, true); }
  });
}

let dark = true, theme: Theme = "system";
function applyTheme() { document.documentElement.dataset.theme = theme === "system" ? (dark ? "dark" : "light") : theme; }
field<HTMLSelectElement>("theme").addEventListener("change", () => {
  theme = value("theme") as Theme;
  applyTheme();
  void invoke("app:settings", {theme}).catch(error => setStatus(error.message, true));
});
window.deptriagem.onTheme(next => { dark = next; applyTheme(); });

field("reset-reports").addEventListener("click", () => { field<HTMLInputElement>("reports-path").value = ""; });
act("save-preferences", async () => {
  await invoke("app:settings", {reports_dir: field<HTMLInputElement>("reports-path").value});
  setStatus("Prefer\u00eancias salvas.");
});

const settingsInput = () => ({catalog_dir: value("catalog-path"), scanner: value("scanner-path")});
const chatInput = () => ({port: numeric("chat-port"), model: value("chat-alias"), seconds: numeric("chat-timeout")});
type ModelRole = "agent" | "reviewer";
interface ModelChoice {provider: string; model?: string; effort?: string; port?: number}
type ModelChoices = Record<ModelRole, ModelChoice>;
const modelRoles = {agent: "Agente", reviewer: "Revisor"};
const modelFields = new Map<ModelRole, HTMLFieldSetElement>();
const controlFor = <T extends HTMLElement = HTMLElement>(role: ModelRole, name: string) =>
  modelFields.get(role)!.querySelector<T>('[data-field="' + name + '"]')!;
function modelChoice(role: ModelRole): ModelChoice {
  const provider = controlFor<HTMLSelectElement>(role, "provider").value;
  if (provider === "off" || provider === "launcher") return {provider};
  return {provider, model: controlFor<HTMLInputElement>(role, "model").value.trim(),
    effort: controlFor<HTMLSelectElement>(role, "effort").value || undefined};
}
const modelChoices = () => ({agent: modelChoice("agent"), reviewer: modelChoice("reviewer")});
interface ModelOutcome {status: string; reason?: string; detail?: string; http_status?: number; port?: number}
const modelStatus: Record<string, string> = {
  connected: "Conex\u00e3o validada", suggestions: "Orienta\u00e7\u00e3o conclu\u00edda",
  missing_credential: "Configure uma credencial para o provedor",
  missing_model: "Informe o ID do modelo", external_not_authorized: "Envio externo dispensado",
  unavailable_or_invalid: "Conex\u00e3o indispon\u00edvel ou resposta inv\u00e1lida",
};
function modelStatusText(result: ModelOutcome) {
  if (result.detail) return result.detail;
  if (result.reason === "timeout") return "O modelo excedeu o tempo limite do chat.";
  if (result.reason === "http") return "O Launcher retornou HTTP " + result.http_status + ".";
  if (result.reason === "connection") return result.port ?
    `O servidor do modelo n\u00e3o respondeu na porta ${result.port}.` : "O servidor do modelo n\u00e3o respondeu.";
  if (result.reason === "invalid") return "Resposta inv\u00e1lida do modelo local.";
  return modelStatus[result.status] ?? result.status;
}
const providerHelp: Record<string, string> = {
  off: "Este papel est\u00e1 desativado.",
  launcher: "Defina o modelo e a porta na aba Launcher.",
  openai: "Informe o ID do modelo e use uma chave OPENAI_API_KEY.",
  codex: "Usa o login ou a chave j\u00e1 configurados no Codex CLI. ID do modelo opcional.",
  claude: "Usa a sessão do Claude Code ou a chave ANTHROPIC_API_KEY, quando configurada.",
  "opencode-cli": "Requer OpenCode CLI 1.x. Informe provedor/modelo e configure a credencial do provedor no CLI ou no ambiente.",
  agy: "Usa a sessão do Antigravity CLI (agy) ou a chave GEMINI_API_KEY, quando configurada.",
  opencode: "Use um modelo do OpenCode Zen compat\u00edvel com Chat Completions e uma chave OPENCODE_API_KEY.",
  gemini: "Informe o ID do modelo e use uma chave GEMINI_API_KEY.",
};
const providerLabel = (provider: string) => [...controlFor<HTMLSelectElement>("agent", "provider").options]
  .find(option => option.value === provider)?.text ?? provider;
let availableKeys: Record<string, boolean> = {};
const projectProvider = (role: ModelRole) => field<HTMLSelectElement>("project-" + role + "-provider");
let savedModels: ModelChoices = {agent: {provider: "launcher"}, reviewer: {provider: "off"}};
let localReviewer: {model?: string; port?: number} | undefined;
interface DeciderChoice {mode: string; port?: number; model?: string; effort?: string}
let savedDecider: DeciderChoice | undefined;
let testingAnalysisDecider = false;
function resolveDecider(choice: string): DeciderChoice | undefined {
  if (choice === "configured" && savedDecider?.mode !== "launcher") return savedDecider;
  if (choice === "launcher") return {mode: "launcher", port: numeric("decider-port")};
  return undefined;
}
function analysisDecider() { return resolveDecider(value("project-decider-selection")); }
function analysisModel(role: ModelRole): ModelChoice {
  const source = projectProvider(role).value;
  if (source === "launcher-reviewer-auto") return {provider: "launcher",
    effort: savedModels.reviewer.provider === "launcher" ? savedModels.reviewer.effort : undefined};
  if (source === "launcher") return {provider: "launcher"};
  if (source === "launcher-reviewer" && localReviewer?.model) return {provider: "launcher", ...localReviewer};
  return source === "agent" || source === "reviewer" ? savedModels[source] : {provider: "off"};
}
function refreshAnalysisChoices(resetConsent = true) {
  const useModels = checked("model-guidance");
  for (const role of Object.keys(modelRoles) as ModelRole[]) {
    const select = projectProvider(role);
    const previous = select.value;
    const options = [new Option("Desativado", "off"), new Option("Modelo principal do Launcher", "launcher")];
    if (role === "reviewer") options.push(new Option("Revisor do Launcher (automático)", "launcher-reviewer-auto"));
    if (localReviewer?.model) options.push(new Option("Revisor local manual", "launcher-reviewer"));
    for (const preset of Object.keys(modelRoles) as ModelRole[]) {
      const choice = savedModels[preset];
      if (choice.provider === "off" || choice.provider === "launcher") continue;
      options.push(new Option(modelRoles[preset] + " de Configurações · " + providerLabel(choice.provider), preset));
    }
    select.replaceChildren(...options);
    const fallback = savedModels[role].provider;
    select.value = options.some(option => option.value === previous) ? previous
      : fallback === "launcher" && role === "reviewer" ? "launcher-reviewer-auto"
      : fallback === "off" || fallback === "launcher" ? fallback : role;
    select.disabled = !useModels;
    const model = analysisModel(role);
    setText("project-" + role + "-model-help", select.value === "launcher-reviewer-auto"
      ? "Usa o Revisor dedicado quando ativo. Caso contrário, usa o modelo principal."
      : model.provider === "off" ? ""
      : model.provider === "launcher" ? model.model || chatInput().model || "Modelo configurado na aba Launcher"
      : (model.model || "Modelo padrão") + (model.effort ? " · " + effortLabels[model.effort] : ""));
    renderModelTest(role);
  }
  const deciderSelection = field<HTMLSelectElement>("project-decider-selection");
  deciderSelection.options[2].disabled = !resolveDecider("configured");
  if (deciderSelection.value === "configured" && deciderSelection.options[2].disabled) deciderSelection.value = "off";
  const decider = analysisDecider();
  deciderSelection.disabled = !useModels;
  field<HTMLButtonElement>("project-decider-test").disabled = !useModels || !decider || testingAnalysisDecider;
  setText("project-decider-model-help", decider ? deciderLabel(decider) : "");
  const needsConsent = useModels && (Object.keys(modelRoles).some(role => !["off", "launcher"].includes(analysisModel(role as ModelRole).provider)) ||
    Boolean(decider && externalDecider(decider.mode)));
  field("external-consent").hidden = !needsConsent;
  if (resetConsent || !needsConsent) field<HTMLInputElement>("allow-external").checked = false;
}
interface ListedModel {id: string; label: string; efforts?: string[]}
const modelCatalogs = new Map<string, ListedModel[]>();
let modelListings: string[] = [];
const modelPicker = field<HTMLDialogElement>("model-picker");
const modelOptions = field<HTMLSelectElement>("model-picker-list");
const modelProviderFilter = field<HTMLSelectElement>("model-picker-provider");
let activePicker: {apply: (id: string) => void; models: ListedModel[]} | undefined;

function filterModelPicker() {
  const search = value("model-picker-filter").toLocaleLowerCase("pt-BR");
  const selected = modelOptions.value;
  const rows = activePicker?.models ?? [];
  const provider = modelProviderFilter.value;
  modelOptions.replaceChildren(...rows.filter(model => (!provider || model.id.startsWith(provider + "/")) &&
    (model.id + " " + model.label).toLocaleLowerCase("pt-BR").includes(search))
    .map(model => new Option(model.label === model.id ? model.id : model.label + " · " + model.id, model.id)));
  if ([...modelOptions.options].some(option => option.value === selected)) modelOptions.value = selected;
  else if (modelOptions.options.length) modelOptions.selectedIndex = 0;
  field<HTMLButtonElement>("model-picker-use").disabled = !modelOptions.value;
}

async function pickModel(title: string, current: string | undefined,
  load: () => Promise<{source: string; models: ListedModel[]}>, apply: (id: string) => void) {
  const selection = {apply, models: [] as ListedModel[]};
  activePicker = selection;
  setText("model-picker-title", "Buscar modelos · " + title);
  setText("model-picker-status", "Consultando catálogo…");
  field("model-picker-results").hidden = true;
  field("model-picker-progress").hidden = false;
  field<HTMLButtonElement>("model-picker-use").disabled = true;
  field<HTMLInputElement>("model-picker-filter").value = "";
  modelProviderFilter.replaceChildren();
  field("model-picker-provider-field").hidden = true;
  modelOptions.replaceChildren();
  modelPicker.showModal();
  try {
    const result = await load();
    if (!modelPicker.open || activePicker !== selection) return;
    selection.models = result.models;
    setText("model-picker-status", result.models.length ? result.source + " · " + result.models.length + " modelos"
      : "Nenhum modelo disponível nesta consulta.");
    if (result.models.length) {
      const providers = [...new Set(result.models.filter(model => model.id.includes("/"))
        .map(model => model.id.split("/")[0]))].sort();
      if (providers.length > 1) {
        modelProviderFilter.replaceChildren(new Option("Todos os provedores", ""),
          ...providers.map(provider => new Option(provider, provider)));
        field("model-picker-provider-field").hidden = false;
      }
      field("model-picker-results").hidden = false;
      filterModelPicker();
      if (current && result.models.some(model => model.id === current)) modelOptions.value = current;
      field("model-picker-filter").focus();
    }
  } catch (error) {
    if (modelPicker.open && activePicker === selection) setText("model-picker-status", (error as Error).message, true);
  } finally {
    if (activePicker === selection) field("model-picker-progress").hidden = true;
  }
}

function openModelPicker(role: ModelRole) {
  const {provider, model} = modelChoice(role);
  return pickModel(modelRoles[role] + " · " + providerLabel(provider), model, async () => {
    const result = await invoke<{source: string; models: ListedModel[]}>("model:list", {provider});
    modelCatalogs.set(provider, result.models);
    return result;
  }, id => {
    if (modelChoice(role).provider !== provider) return;
    controlFor<HTMLInputElement>(role, "model").value = id;
    refreshModels();
  });
}

function useListedModel() {
  if (!activePicker || !modelOptions.value) return;
  activePicker.apply(modelOptions.value);
  modelPicker.close();
}
field("model-picker-filter").addEventListener("input", filterModelPicker);
modelProviderFilter.addEventListener("change", filterModelPicker);
field("model-picker-close").addEventListener("click", () => modelPicker.close());
field("model-picker-use").addEventListener("click", useListedModel);
modelOptions.addEventListener("dblclick", useListedModel);
modelOptions.addEventListener("keydown", event => { if (event.key === "Enter") useListedModel(); });
const quickTest = (role: ModelRole) => field<HTMLButtonElement>("project-" + role + "-test");
const testResults = new Map<ModelRole, {choice: string; text: string; error: boolean}>();
const pendingTests = new Set<ModelRole>();
function automaticReviewerInput(enabled: boolean) {
  return enabled ? {automaticReviewer: true, launcherControl: launcher ? controlInput() : undefined} : {};
}
function testInput(role: ModelRole, analysis: boolean) {
  return {model: analysis ? analysisModel(role) : modelChoice(role), local: chatInput(),
    ...automaticReviewerInput(role === "reviewer" && (analysis
      ? projectProvider(role).value === "launcher-reviewer-auto" : modelChoice(role).provider === "launcher"))};
}
function testChoice({launcherControl, ...input}: ReturnType<typeof testInput>) {
  return JSON.stringify({...input, controlPort: launcherControl?.port,
    reviewer: input.automaticReviewer ? launcher?.servers.reviewer : undefined});
}
function renderModelTest(role: ModelRole) {
  const result = testResults.get(role);
  controlFor<HTMLButtonElement>(role, "test").disabled = modelChoice(role).provider === "off" || pendingTests.has(role);
  quickTest(role).disabled = analysisModel(role).provider === "off" || pendingTests.has(role) || !checked("model-guidance");
  for (const [status, analysis] of [[controlFor(role, "status"), false], [field("project-" + role + "-test-status"), true]] as const) {
    const current = result?.choice === testChoice(testInput(role, analysis)) ? result : undefined;
    status.textContent = current?.text ?? "";
    if (current?.error) status.dataset.error = "true";
    else delete status.dataset.error;
  }
}
async function runModelTest(role: ModelRole, analysis = false) {
  if (pendingTests.has(role)) return;
  const input = testInput(role, analysis);
  const choice = testChoice(input);
  pendingTests.add(role);
  testResults.set(role, {choice, text: "Testando com dados fictícios…", error: false});
  renderModelTest(role);
  try {
    const outcome = await invoke<ModelOutcome>("model:test", input);
    testResults.set(role, {choice, text: modelStatusText(outcome),
      error: outcome.status !== "connected" && outcome.status !== "disabled"});
  } catch (error) {
    testResults.set(role, {choice, text: (error as Error).message, error: true});
  } finally {
    pendingTests.delete(role);
    renderModelTest(role);
  }
}
let availableEfforts: Record<string, string[]> = {};
const effortLabels: Record<string, string> = {
  "": "Padr\u00e3o", none: "Sem racioc\u00ednio", minimal: "M\u00ednimo", low: "Baixo",
  medium: "M\u00e9dio", high: "Alto", xhigh: "Muito alto", max: "M\u00e1ximo", server: "Configura\u00e7\u00e3o do servidor",
};
function renderEffort(role: ModelRole, provider: string, value: string) {
  const model = modelChoice(role).model;
  const confirmed = modelCatalogs.get(provider)?.find(item => item.id === model)?.efforts;
  const values = ["", ...(confirmed ?? availableEfforts[provider] ?? [])];
  const select = controlFor<HTMLSelectElement>(role, "effort");
  if (select.options.length !== values.length || values.some((option, index) => select.options[index].value !== option)) {
    select.replaceChildren(...values.map(option => new Option(effortLabels[option] || option, option)));
  }
  select.value = values.includes(value) ? value : "";
}
const drafts: Record<ModelRole, Map<string, {model: string; effort: string}>> = {agent: new Map(), reviewer: new Map()};
function switchProvider(role: ModelRole, previous: string, next: string) {
  const model = controlFor<HTMLInputElement>(role, "model");
  drafts[role].set(previous, {model: model.value, effort: controlFor<HTMLSelectElement>(role, "effort").value});
  const previousDraft = drafts[role].get(next);
  controlFor<HTMLSelectElement>(role, "provider").value = next;
  model.value = previousDraft?.model ?? "";
  renderEffort(role, next, previousDraft?.effort ?? "");
  controlFor<HTMLInputElement>(role, "key").value = "";
  testResults.delete(role);
  refreshModels();
}
function refreshModels(resetConsent = true) {
  const choices = modelChoices();
  for (const role of Object.keys(modelRoles) as ModelRole[]) {
    const {provider, effort} = choices[role];
    const set = modelFields.get(role)!;
    const sections = {model: provider !== "off" && provider !== "launcher",
      effort: provider !== "launcher" && Boolean(availableEfforts[provider]?.length), key: Object.hasOwn(availableKeys, provider)};
    for (const [section, visible] of Object.entries(sections)) {
      set.querySelector<HTMLElement>('[data-section="' + section + '"]')!.hidden = !visible;
    }
    controlFor(role, "help").textContent = providerHelp[provider] +
      (availableKeys[provider] ? " Chave dispon\u00edvel." : "");
    renderEffort(role, provider, effort ?? "");
    controlFor(role, "search").hidden = !modelListings.includes(provider);
  }
  refreshAnalysisChoices(resetConsent);
}
for (const role of Object.keys(modelRoles) as ModelRole[]) {
  const item = field<HTMLTemplateElement>("model-role").content.firstElementChild!.cloneNode(true) as HTMLFieldSetElement;
  modelFields.set(role, item);
  item.querySelector("legend")!.textContent = modelRoles[role];
  field("model-roles").append(item);
  controlFor<HTMLSelectElement>(role, "provider").value = role === "agent" ? "launcher" : "off";
  const configuredProvider = controlFor<HTMLSelectElement>(role, "provider");
  configuredProvider.dataset.previous = configuredProvider.value;
  configuredProvider.addEventListener("change", () => {
    switchProvider(role, configuredProvider.dataset.previous!, configuredProvider.value);
    configuredProvider.dataset.previous = configuredProvider.value;
  });
  projectProvider(role).addEventListener("change", () => refreshAnalysisChoices());
  controlFor(role, "search").addEventListener("click", () => void openModelPicker(role));
  controlFor(role, "effort").addEventListener("change", () => refreshModels());
  controlFor(role, "model").addEventListener("input", () => refreshModels());
  for (const action of ["apply", "clear"]) controlFor<HTMLButtonElement>(role, action).addEventListener("click", async () => {
    const input = controlFor<HTMLInputElement>(role, "key");
    const key = action === "apply" ? input.value.trim() : "";
    input.value = "";
    if (action === "apply" && !key) return;
    try {
      availableKeys = await invoke("model:credential", {provider: modelChoice(role).provider, key});
      modelCatalogs.delete(modelChoice(role).provider);
      testResults.clear();
      refreshModels();
      setStatus(action === "apply" ? "Chave dispon\u00edvel nesta sess\u00e3o." : "Chave da sess\u00e3o removida.");
    } catch (error) { setStatus((error as Error).message, true); }
  });
  controlFor(role, "test").addEventListener("click", () => void runModelTest(role));
  quickTest(role).addEventListener("click", () => void runModelTest(role, true));
}
field("model-roles").append(field<HTMLTemplateElement>("decider-settings-template").content.cloneNode(true));
field("model-guidance").addEventListener("change", () => refreshModels());
act("save-models", async () => {
  const saved = await invoke<{models: ModelChoices; triage_decider: DeciderChoice}>("app:settings", {
    models: modelChoices(), triage_decider: triageDecider(),
  });
  savedModels = saved.models;
  savedDecider = saved.triage_decider;
  setText("project-decider-test-status", "");
  refreshTriageSelection(true);
  for (const role of Object.keys(modelRoles) as ModelRole[]) projectProvider(role).selectedIndex = -1;
  refreshAnalysisChoices();
  setStatus("Modelos salvos.");
});
refreshModels();
field("source-kind").addEventListener("change", () => {
  const github = value("source-kind") === "github";
  field("source-local").hidden = github;
  field("source-github").hidden = !github;
});
let githubAccountRequest = 0;
let githubLoginPending = false;
function showAccount(state: "disconnected" | "unverified" | "verified", login?: string) {
  const text = state === "verified" ? "GitHub · " + login
    : state === "unverified" ? "Conta ainda não verificada" : "Conta não conectada";
  for (const id of ["source-account", "github-account", "mcp-account"]) {
    field(id).dataset.state = state;
    setText(id, text);
  }
  if (state === "verified") githubLoginPending = false;
}
async function refreshGithubAccount(verify = false) {
  const request = ++githubAccountRequest;
  showAccount("unverified");
  const configured = await invoke<boolean>("github:configured");
  if (githubAccountRequest !== request) return;
  if (!configured) {
    showAccount("disconnected");
    if (verify) setStatus("Conta não conectada. Conecte a conta do GitHub para verificar.");
    return;
  }
  if (verify) {
    const login = await invoke<string>("github:account");
    if (githubAccountRequest !== request) return;
    showAccount("verified", login);
    setStatus("Conta GitHub conectada.");
  }
}
async function githubRepositories() {
  const request = ++githubAccountRequest;
  try {
    const result = await invoke<{login: string; repos: string[]}>("github:repositories");
    if (request === githubAccountRequest) showAccount("verified", result.login);
    return result;
  } catch (error) {
    if (request === githubAccountRequest) await refreshGithubAccount();
    throw error;
  }
}
async function listRepositories() {
  setStatus("Consultando repositórios da conta…");
  const result = await githubRepositories();
  field("repositories").replaceChildren(...result.repos.map(name => new Option(name, name)));
  setStatus("Selecione um repositório ou informe dono/nome.");
}
act("repo-list", listRepositories);
act("mcp-repo-list", listRepositories);
act("github-check", () => refreshGithubAccount(true));
act("github-login", async () => {
  await invoke("github:login");
  githubLoginPending = true;
  await refreshGithubAccount();
  setStatus("Conclua a autenticação do GitHub CLI e clique em Verificar conta.");
});
window.addEventListener("focus", () => {
  if (githubLoginPending) void refreshGithubAccount().catch(error => setStatus(error.message, true));
});

function projectSource() {
  const kind = value("source-kind");
  return {kind, target: value(kind === "local" ? "project-folder" : "project-repo"),
    ref: kind === "github" ? value("project-ref") : undefined,
    commit: kind === "local" ? value("project-commit") : undefined};
}

function mcpInput() {
  const kind = value("mcp-kind");
  return {host: value("mcp-client"), kind, target: kind === "local" ? value("mcp-folder")
    : kind === "github" ? value("mcp-repo") : undefined, ref: kind === "github" ? value("mcp-ref") : undefined,
    commit: kind === "local" ? value("mcp-commit") : undefined,
    workspace: value("mcp-workspace") || (kind === "local" ? value("mcp-folder") : undefined)};
}

let mcpRevision = 0;
let mcpTestRevision = 0;
async function refreshMcp(sourceChanged: boolean) {
  const revision = ++mcpRevision;
  const input = mcpInput();
  field("mcp-local").hidden = input.kind !== "local";
  field("mcp-github").hidden = input.kind !== "github";
  field("mcp-data-note").hidden = input.kind === "catalogs";
  if (sourceChanged) {
    mcpTestRevision++;
    setText("mcp-test-status", "Aguardando teste do servidor.");
  }
  field("mcp-snippet").hidden = true;
  setText("mcp-snippet", "");
  setText("mcp-config-status", "");
  setText("mcp-client-status", "");
  try {
    const destination = await invoke<{path: string; needsWorkspace: boolean}>("mcp:destination", input);
    if (revision !== mcpRevision) return;
    field("mcp-workspace-field").hidden = ["codex", "gemini", "antigravity"].includes(input.host);
    setText("mcp-destination", destination.needsWorkspace ? "No projeto, use " + destination.path + "." : destination.path);
  } catch (error) {
    if (revision === mcpRevision) setText("mcp-config-status", (error as Error).message, true);
  }
}

for (const id of ["mcp-client", "mcp-kind", "mcp-folder", "mcp-commit", "mcp-repo", "mcp-ref", "mcp-workspace"]) {
  field(id).addEventListener(id === "mcp-client" || id === "mcp-kind" ? "change" : "input", () => {
    void refreshMcp(!["mcp-client", "mcp-workspace"].includes(id));
  });
}
act("project-to-mcp", async () => {
  const source = projectSource();
  field<HTMLSelectElement>("mcp-kind").value = source.kind;
  if (source.kind === "local") {
    field<HTMLInputElement>("mcp-folder").value = source.target;
    field<HTMLInputElement>("mcp-commit").value = source.commit ?? "";
  }
  else {
    field<HTMLInputElement>("mcp-repo").value = source.target;
    field<HTMLInputElement>("mcp-ref").value = source.ref ?? "";
  }
  field<HTMLInputElement>("mcp-workspace").value = "";
  showPage("mcp");
  await refreshMcp(true);
});
act("mcp-test", async () => {
  const revision = mcpTestRevision;
  setText("mcp-test-status", "Testando servidor local…");
  try {
    const result = await invoke<{protocolVersion: string; tools: string[]}>("mcp:test", mcpInput());
    if (revision === mcpTestRevision) setText("mcp-test-status",
      "Servidor local respondeu · MCP " + result.protocolVersion + " · " + result.tools.join(", "));
  } catch (error) {
    if (revision === mcpTestRevision) setText("mcp-test-status", (error as Error).message, true);
  }
});
act("mcp-check-client", async () => {
  const revision = mcpRevision;
  setText("mcp-client-status", "Consultando a última conexão…");
  try {
    const connectedAt = await invoke<string | null>("mcp:connection", mcpInput());
    if (revision === mcpRevision) setText("mcp-client-status", connectedAt
      ? "Última conexão confirmada em " + new Date(connectedAt).toLocaleString("pt-BR") + "."
      : "Aguardando a primeira conexão com esta configuração.");
  } catch (error) {
    if (revision === mcpRevision) setText("mcp-client-status", (error as Error).message, true);
  }
});
for (const action of ["preview", "copy", "open-location"] as const) {
  act("mcp-" + action, async () => {
    const revision = mcpRevision;
    setText("mcp-config-status", "");
    try {
      const result = await invoke<string | boolean>("mcp:" + action, mcpInput());
      if (revision !== mcpRevision) return;
      if (typeof result === "string") {
        setText("mcp-snippet", result);
        field("mcp-snippet").hidden = false;
      }
      if (action === "copy") setText("mcp-config-status", "Configuração copiada.");
    } catch (error) {
      if (revision === mcpRevision) setText("mcp-config-status", (error as Error).message, true);
    }
  });
}
act("mcp-manual", async () => { await invoke("manual:open", {name: "integration"}); });
void refreshMcp(true);

let project: Report | undefined, imported: Report | undefined, launcher: LauncherState | null = null;
let availableUpdate = false;
const reasons: Record<string, string> = {
  manifest_without_scanned_lockfile: "Manifesto sem lockfile analisado",
  language_without_lockfile: "Linguagem detectada sem inventário de dependências",
  no_packages_scanned: "Nenhum pacote verificado", kev_stale_or_future: "Catálogo KEV fora da validade",
  kev_missing: "Catálogo CISA KEV ausente", catalog_missing: "Catálogo OSV ausente",
  not_fully_pinned: "Manifesto com versões não fixadas", no_packages_reported: "Scanner sem inventário para o arquivo",
  lockfile_ignored_by_git: "Arquivo de dependências ignorado pelo Git",
  nested_repository: "Repositório interno ou submódulo fora desta análise",
  linked_path_skipped: "Vínculo ou junção fora do inventário local",
  git_metadata_not_inspected: "Metadados Git fora do inventário local",
  osv_snapshot_needs_refresh: "Atualização do OSV pendente", scanner_reported_diagnostics: "O scanner registrou avisos",
};
function showReport(data: Report, mode: "project" | "review") {
  const summary = `${data.packages_reported} entradas verificadas · ${data.findings.length} achados`;
  setText(mode + "-summary", summary + (data.coverage === "partial" ? " · Cobertura parcial" : ""));
  const rows = [];
  if (data.source) rows.push([data.source.directory || data.source.repository, data.source.commit?.slice(0, 12)].filter(Boolean).join(" @ "));
  for (const issue of data.coverage_issues || []) {
    const location = issue.path || issue.ecosystem;
    rows.push((reasons[issue.reason] || issue.reason) + (location ? ` · ${location}` : ""));
  }
  for (const finding of data.findings.slice(0, 240)) {
    rows.push(`${finding.name} ${finding.version} · ${finding.ids.join(", ")} · ${finding.priority === "maximum" ? "KEV · prioridade máxima" : "Revisão manual"}`);
    const severityLabels: Record<string, string> = {none: "Nenhuma", low: "Baixa", medium: "Média", high: "Alta", critical: "Crítica"};
    const metadata = [finding.severity && "Severidade " + (severityLabels[finding.severity] ?? finding.severity),
      typeof finding.cvss === "number" && "CVSS base " + finding.cvss,
      finding.fixed_versions?.length && "Versões corrigidas publicadas " + finding.fixed_versions.join(", ")].filter(Boolean);
    if (metadata.length) rows.push("  " + metadata.join(" · "));
    if (finding.fix_disagreement) rows.push("  Correções divergentes por fonte · " +
      (finding.advisories ?? []).filter(item => item.fixed_versions.length).map(item => item.id + " " + item.fixed_versions.join(", ")).join(" · "));
  }
  if (data.findings.length > 240) rows.push("Os demais achados estão no relatório JSON.");
  if (data.model_guidance?.status === "suggestions") {
    rows.push("", "Verificações sugeridas pelo modelo", ...(data.model_guidance.checks ?? []).map(item => item.description));
  }
  if (data.model_guidance?.status === "unavailable_or_invalid" && !data.model_guidance.roles?.length) {
    rows.push(modelStatus.unavailable_or_invalid);
  }
  for (const item of data.model_guidance?.roles ?? []) {
    const reviewer = item.role === "reviewer" ? data.model_guidance?.reviewer_launcher : undefined;
    const provider = reviewer ? `${reviewer.source === "dedicated" ? "Revisor dedicado" : "Modelo principal do Launcher"} · ${reviewer.model} · porta ${reviewer.port}`
      : providerLabel(item.provider);
    rows.push(modelRoles[item.role] + " \u00b7 " + provider + " \u00b7 " + modelStatusText(item));
  }
  if (mode === "project") {
    const decision = data.model_decision;
    field("project-decision-result").hidden = !decision;
    if (decision) {
      const failed = decision.reason === "decider_unavailable";
      const detail = failed ? decision.detail || "Decisor indisponível."
        : decision.reason === "external_not_authorized" ? "Envio do resumo ao Decisor não autorizado." : "";
      setText("project-decision-result", ["Decisor · " + (queueLabels[decision.queue] ?? decision.queue), detail]
        .filter(Boolean).join(" · "), failed);
    }
  }
  setText(mode + "-result", rows.join("\n"));
  field(mode + "-result").hidden = !rows.length;
}
act("analyze", async () => {
  project = undefined;
  repaintControls();
  setStatus("Lendo os manifestos e verificando as dependências…");
  field("project-result").hidden = true;
  field("project-decision-result").hidden = true;
  setText("project-summary", "Análise em andamento.");
  try {
    const allowExternal = checked("allow-external");
    field<HTMLInputElement>("allow-external").checked = false;
    project = await invoke<Report>("project:analyze", {
      ...projectSource(),
      ...settingsInput(), guidance: chatInput(),
      ...automaticReviewerInput(checked("model-guidance") && projectProvider("reviewer").value === "launcher-reviewer-auto"),
      models: checked("model-guidance") ? {agent: analysisModel("agent"), reviewer: analysisModel("reviewer")} : false,
      decider: checked("model-guidance") ? analysisDecider() : undefined, allowExternal,
    });
    showReport(project, "project");
    if (project.model_guidance?.roles?.some(item => item.provider === "launcher" && item.status === "unavailable_or_invalid")) {
      void refreshLauncher();
    }
    setStatus("Análise concluída. O relatório JSON está disponível.");
  } catch (error) { setText("project-summary", "Análise não concluída.", true); throw error; }
});
act("review", async () => {
  imported = undefined; repaintControls(); setStatus("Conferindo os achados…");
  field("review-result").hidden = true;
  imported = await invoke<Report>("project:review", {osv: value("review-osv"), kev: value("review-kev")});
  showReport(imported, "review"); setStatus("Relatório processado.");
});
for (const [id, report] of [["save-project", () => project], ["save-review", () => imported]] as const) {
  act(id, async () => { if (await invoke("app:save-report", {report: report()})) setStatus("Relatório JSON salvo."); });
}
act("export-project", async () => {
  const result = await invoke<{directory: string; files: string[]} | null>("app:export-analysis", {report: project});
  if (result) setStatus(result.files.join(", ") + " exportados em " + result.directory + ".");
});
act("open-report", async () => {
  const path = await invoke<string | null>("app:pick", {type: "text"});
  if (path) {
    field<HTMLTextAreaElement>("report").value = await invoke("app:read-report", {path});
    resetTriageConsent();
  }
});
const queueLabels: Record<string, string> = {security: "Segurança", functional_bug: "Bug funcional",
  needs_review: "Revisão humana", priority_review: "Priorizar revisão", routine_review: "Revisão de rotina"};
const deciderProviders: Record<string, string> = {
  codex: "codex", claude: "claude", openai: "openai", agy: "agy", gemini: "gemini", opencode: "opencode-cli", "opencode-zen": "opencode",
};
const externalDecider = (mode: string) => Object.hasOwn(deciderProviders, mode);
const deciderUsesModel = (mode: string) => externalDecider(mode) || mode === "opencode-local";
function triageDecider(): DeciderChoice {
  const mode = value("triage-decider-mode");
  if (deciderUsesModel(mode)) return {mode, model: value("triage-opencode-model"),
    effort: externalDecider(mode) ? value("triage-model-effort") || undefined : undefined,
    port: mode === "opencode-local" ? numeric("triage-opencode-port") : undefined};
  const selectedPort = mode === "chat" ? "triage-chat-port" : mode === "systemone" ? "triage-systemone-port" : "decider-port";
  return {mode, port: numeric(selectedPort), model: mode === "chat" ? value("triage-chat-model") : undefined};
}
function resetTriageConsent() { field<HTMLInputElement>("triage-allow-external").checked = false; }
function effectiveDecider(): DeciderChoice {
  return resolveDecider(value("triage-decider-selection")) ?? {mode: "launcher", port: numeric("decider-port")};
}
function deciderLabel(decider: DeciderChoice) {
  const editor = field<HTMLSelectElement>("triage-decider-mode");
  const label = [...editor.options].find(option => option.value === decider.mode)?.text;
  return decider.mode === "launcher" ? "Porta " + (decider.port ?? 8090) + " na aba Launcher"
    : [label, decider.model, decider.effort && effortLabels[decider.effort]].filter(Boolean).join(" · ");
}
function refreshTriageSelection(preferSaved = false) {
  const select = field<HTMLSelectElement>("triage-decider-selection");
  const configured = select.options[1];
  configured.disabled = !savedDecider || savedDecider.mode === "launcher";
  if (configured.disabled) select.value = "launcher";
  else if (preferSaved) select.value = "configured";
  const resolved = effectiveDecider();
  setText("triage-decider-selection-help", deciderLabel(resolved));
  field("triage-external-consent").hidden = !externalDecider(resolved.mode);
  resetTriageConsent();
}
field("triage-decider-selection").addEventListener("change", () => refreshTriageSelection());
for (const id of ["jump-decider-settings", "open-decider-settings"]) {
  field(id).addEventListener("click", () => field("triage-decider-heading").scrollIntoView({block: "start"}));
}
function showDeciderEfforts(model = value("triage-opencode-model"), selected = value("triage-model-effort")) {
  const mode = value("triage-decider-mode");
  const provider = deciderProviders[mode];
  const confirmed = modelCatalogs.get(provider)?.find(item => item.id === model)?.efforts;
  const options = confirmed ?? availableEfforts[provider] ?? [];
  const effort = field<HTMLSelectElement>("triage-model-effort");
  effort.replaceChildren(new Option("Padrão", ""), ...options.map(option => new Option(effortLabels[option] || option, option)));
  effort.value = options.includes(selected) ? selected : "";
  field("triage-model-effort-field").hidden = !options.length;
}
function refreshTriageDecider() {
  const {mode} = triageDecider();
  field("triage-systemone-fields").hidden = mode !== "systemone";
  field("triage-chat-fields").hidden = mode !== "chat";
  field("triage-opencode-fields").hidden = !deciderUsesModel(mode);
  field("triage-opencode-port-field").hidden = mode !== "opencode-local";
  const provider = deciderProviders[mode];
  field("triage-key-field").hidden = !Object.hasOwn(availableKeys, provider);
  field("triage-opencode-search").hidden = mode !== "opencode-local" && !modelListings.includes(provider);
  field<HTMLInputElement>("triage-opencode-model").placeholder = mode === "opencode" ? "provedor/modelo" : "ID do modelo";
  showDeciderEfforts();
  const hints: Record<string, string> = {
    launcher: "Usa a porta do Decisor na aba Launcher.",
    systemone: "Usa /v1/systemone em 127.0.0.1. Inicie o servidor SystemOne antes do teste.",
    chat: "Usa /v1/chat/completions em 127.0.0.1. Inicie o servidor do modelo local antes do teste.",
    opencode: "Escolha provedor/modelo entre os provedores integrados do OpenCode CLI 1.x.",
    "opencode-local": "Inicie o servidor local que expõe o modelo por /v1/chat/completions e informe a porta.",
  };
  setText("triage-decider-help", hints[mode] ?? providerHelp[provider] ?? "");
  setText("triage-decider-status", "");
}
field("triage-decider-mode").addEventListener("change", () => {
  field<HTMLInputElement>("triage-opencode-model").value = "";
  field<HTMLInputElement>("triage-model-key").value = "";
  field<HTMLSelectElement>("triage-model-effort").value = "";
  refreshTriageDecider();
});
field("report").addEventListener("input", resetTriageConsent);
for (const id of ["triage-systemone-port", "triage-chat-port", "triage-chat-model", "decider-port", "triage-opencode-port", "triage-opencode-model"]) {
  field(id).addEventListener("input", () => { setText("triage-decider-status", ""); resetTriageConsent(); });
}
field("triage-opencode-search").addEventListener("click", () => {
  const decider = triageDecider();
  const provider = deciderProviders[decider.mode];
  void pickModel("Decisor", decider.model, async () => {
    const result = await invoke<{source: string; models: ListedModel[]}>("triage:models", {decider});
    if (provider) modelCatalogs.set(provider, result.models);
    return result;
  }, id => {
    if (triageDecider().mode !== decider.mode || triageDecider().port !== decider.port) return;
    field<HTMLInputElement>("triage-opencode-model").value = id;
    showDeciderEfforts(id);
    setText("triage-decider-status", "");
    resetTriageConsent();
  });
});
for (const operation of ["use", "clear"]) act("triage-" + operation + "-key", async () => {
  const provider = deciderProviders[value("triage-decider-mode")];
  const input = field<HTMLInputElement>("triage-model-key");
  const key = operation === "use" ? input.value.trim() : "";
  input.value = "";
  if (operation === "use" && !key) return;
  availableKeys = await invoke("model:credential", {provider, key});
  modelCatalogs.delete(provider);
  refreshModels();
  refreshTriageDecider();
  setText("triage-decider-status", key ? "Chave disponível nesta sessão." : "Chave da sessão removida.");
});
act("save-triage-decider", async () => {
  const decider = triageDecider();
  const saved = await invoke<{triage_decider: DeciderChoice}>("app:settings", {triage_decider: decider});
  savedDecider = saved.triage_decider;
  setText("project-decider-test-status", "");
  refreshAnalysisChoices();
  refreshTriageSelection(true);
  setText("triage-decider-status", "Configuração do Decisor salva.");
});
field("project-decider-selection").addEventListener("change", () => {
  setText("project-decider-test-status", "");
  refreshAnalysisChoices();
});
act("project-decider-test", async () => {
  const decider = analysisDecider();
  if (!decider) return;
  const snapshot = JSON.stringify(decider);
  const update = (text: string, error = false) => {
    if (snapshot === JSON.stringify(analysisDecider())) setText("project-decider-test-status", text, error);
  };
  testingAnalysisDecider = true;
  update("Testando com dados fictícios…");
  try {
    const result = await invoke<{ok: boolean; detail?: string}>("triage:test", {decider, analysis: true});
    update(result.ok ? "O Decisor respondeu com uma fila válida."
      : result.detail || "O Decisor não retornou uma classificação válida.", !result.ok);
  } catch (error) { update((error as Error).message, true); }
  finally { testingAnalysisDecider = false; }
});
act("test-triage-decider", async () => {
  const decider = triageDecider();
  const snapshot = JSON.stringify(decider);
  setText("triage-decider-status", "Testando com dados fictícios…");
  try {
    const result = await invoke<{ok: boolean; detail?: string}>("triage:test", {decider});
    if (snapshot === JSON.stringify(triageDecider())) setText("triage-decider-status",
      result.ok ? "O Decisor respondeu com uma classificação válida."
        : result.detail || "O Decisor não retornou uma classificação válida. Confira a conexão e o modelo.", !result.ok);
  } catch (error) {
    if (snapshot === JSON.stringify(triageDecider())) setText("triage-decider-status", (error as Error).message, true);
  }
});
act("triage", async () => {
  setStatus("Classificando o relato…");
  const decider = effectiveDecider();
  const allowExternal = checked("triage-allow-external");
  resetTriageConsent();
  const result = await invoke<{queue: string; reason: string; detail?: string; probabilities?: Record<string, number>; note?: string;
    note_unavailable?: boolean}>("triage:run", {report: value("report"), decider,
    note: checked("triage-note"), launcherChat: chatInput(), allowExternal});
  const lines = [`Fila sugerida: ${queueLabels[result.queue] || result.queue}`];
  if (result.reason === "decider_unavailable") lines.push(result.detail || "Decisor indisponível.");
  if (result.reason === "external_not_authorized") lines.push("Autorize o envio do relato para usar o provedor do Decisor.");
  if ((decider.mode === "chat" || deciderUsesModel(decider.mode)) && result.probabilities) lines.push("Estimativas do modelo");
  for (const [name, rating] of Object.entries(result.probabilities || {})) {
    lines.push(`${queueLabels[name]}: ${Math.round(rating * 100)}%`);
  }
  if (result.note) lines.push("", "Parecer opcional para revisão humana", result.note);
  if (result.note_unavailable) lines.push("", "Parecer indisponível.");
  const error = ["decider_unavailable", "external_not_authorized"].includes(result.reason) || Boolean(result.note_unavailable);
  setText("triage-result", lines.join("\n"), error);
  setStatus(result.reason === "external_not_authorized" ? "Envio do relato pendente de autorização."
    : error ? "Triagem com servi\u00e7o indispon\u00edvel." : "Triagem conclu\u00edda.", error);
});

const launcherChoice: Partial<Record<Role, string>> = {};
const launcherPending = new Map<Role, "start" | "stop">();
const launcherFailures = new Map<Role, {label: string; detail: string}>();
function repaintControls() {
  field<HTMLButtonElement>("project-decider-test").disabled = !checked("model-guidance") || !analysisDecider() || testingAnalysisDecider;
  field<HTMLButtonElement>("save-project").disabled = !project;
  field<HTMLButtonElement>("export-project").disabled = !project;
  field<HTMLButtonElement>("save-review").disabled = !imported;
  field<HTMLButtonElement>("apply-update").disabled = !availableUpdate;
  field<HTMLButtonElement>("quit-launcher").disabled = !launcher;
  for (const role of launcherRoles) {
    const server = launcher?.servers[role];
    const picker = field<HTMLSelectElement>(role + "-models");
    picker.disabled = Boolean(!launcher || server || launcherPending.has(role) || !picker.options.length);
    field<HTMLButtonElement>("start-" + role).disabled = picker.disabled || !picker.value;
    field<HTMLButtonElement>("stop-" + role).disabled = !server || launcherPending.has(role);
  }
}
type Health = {ok: boolean; label: string};
type ModelHealth = Partial<Record<Role, Health | null>>;
let watchEnabled = false;
let watching = false;
let credentialsRevision = 0;
let controlRevision = 0;
let activeControl = 0;
function launcherStatus(role: Role, label: string, error = false, stopped = false) {
  const id = role + "-status";
  const failure = launcherFailures.get(role);
  const detail = field(role + "-control-error");
  detail.textContent = failure?.detail ?? "";
  detail.hidden = !failure;
  if (failure) { label = failure.label; error = true; }
  setText(id, label, error);
  if (stopped && !error) field(id).dataset.state = "stopped";
  else delete field(id).dataset.state;
}
function displayLauncher(state: LauncherState | null, disconnected = false, health: ModelHealth = {}) {
  const previous = launcher;
  launcher = state;
  setText("launcher-control-status", disconnected ? "Controle indispon\u00edvel" : state ? "Conectado" : "N\u00e3o verificada", disconnected);
  for (const role of launcherRoles) {
    const supported = state && role in state.servers;
    const modelList = supported ? state.models.filter(model => model.role === (role === "reviewer" ? "chat" : role)) : [];
    const picker = field<HTMLSelectElement>(role + "-models");
    const server = state?.servers[role];
    const selected = server?.model_id || launcherChoice[role] || picker.value;
    if (picker.options.length !== modelList.length ||
      modelList.some((model, index) => picker.options[index].value !== model.id || picker.options[index].text !== model.name)) {
      picker.replaceChildren(...modelList.map(item => new Option(item.name, item.id)));
    }
    if (modelList.some(item => item.id === selected)) picker.value = selected;
    const local = server && (!server.host || ["127.0.0.1", "localhost", "::1"].includes(server.host));
    const pending = launcherPending.get(role);
    const check = health[role];
    const label = disconnected ? "Conex\u00e3o perdida"
      : pending === "start" ? "Carregando" : pending === "stop" ? "Parando"
      : local && check && !check.ok ? `${check.label} \u00b7 ${server.port}`
      : server ? local ? `Em execu\u00e7\u00e3o \u00b7 ${server.port}` : "Em execu\u00e7\u00e3o na rede"
      : state && !supported ? "Indisponível nesta versão"
      : state ? modelList.length ? "Parado" : "Sem modelos compat\u00edveis" : "Status n\u00e3o verificado";
    launcherStatus(role, label, disconnected || Boolean(!pending && local && check && !check.ok),
      Boolean(state && picker.value && !server && !pending));
    if (local && role !== "reviewer") {
      if (previous?.servers[role]?.port !== server.port) field<HTMLInputElement>(role + "-port").value = String(server.port);
      if (role === "chat" && previous?.servers[role]?.api_model !== server.api_model) {
        field<HTMLInputElement>("chat-alias").value = server.api_model || "modelo-local";
      }
    }
  }
  repaintControls();
  renderModelTest("reviewer");
}
const controlInput = () => ({port: numeric("control-port"), token: value("control-token")});
async function control(action: string, role?: Role) {
  const revision = credentialsRevision;
  controlRevision++;
  activeControl++;
  try {
    const result = await invoke<LauncherState | null>("launcher:control", {action, role, ...controlInput(),
      model_id: role ? value(role + "-models") : undefined});
    if (revision === credentialsRevision) displayLauncher(result);
    return revision === credentialsRevision;
  } finally {
    activeControl--;
    controlRevision++;
  }
}
async function refreshLauncher() {
  if (!watchEnabled || watching || activeControl) return;
  watching = true;
  const revision = controlRevision;
  try {
    const {state, health} = await invoke<{state: LauncherState; health: ModelHealth}>("launcher:watch", controlInput());
    if (watchEnabled && revision === controlRevision) {
      const recovered = !launcher;
      displayLauncher(state, false, health);
      if (recovered && !field("page-launcher").hidden) setStatus("Controle do Launcher reconectado.");
    }
  } catch {
    if (watchEnabled && revision === controlRevision) {
      const connected = Boolean(launcher);
      displayLauncher(null, true);
      if (connected && !field("page-launcher").hidden) setStatus("Conex\u00e3o com o controle do Launcher perdida.", true);
    }
  } finally { watching = false; }
}
function resetLauncherConnection() {
  credentialsRevision++;
  controlRevision++;
  watchEnabled = false;
  launcherFailures.clear();
  displayLauncher(null);
}
field("control-token").addEventListener("input", resetLauncherConnection);
field("control-port").addEventListener("input", resetLauncherConnection);
setInterval(() => { void refreshLauncher(); }, 5000);
act("open-launcher", async () => { await invoke("launcher:open"); setStatus("Abertura do Launcher solicitada."); });
act("connect-launcher", async () => {
  const revision = credentialsRevision;
  try {
    if (await control("state")) {
      watchEnabled = true;
      void refreshLauncher();
      setStatus("Controle do Launcher conectado.");
    }
  } catch (error) { if (revision === credentialsRevision) displayLauncher(null, true); throw error; }
});
type TokenStatus = {protected: boolean; saved: boolean};
function showTokenStatus(state: TokenStatus) {
  field<HTMLButtonElement>("remember-launcher-token").disabled = !state.protected;
  field("forget-launcher-token").hidden = !state.saved;
  field<HTMLInputElement>("control-token").placeholder = state.saved ? "Token guardado neste perfil" : "";
}
act("remember-launcher-token", async () => {
  const status = await invoke<TokenStatus>("launcher:remember-token", controlInput());
  field<HTMLInputElement>("control-token").value = "";
  showTokenStatus(status);
  setStatus("Token guardado com a prote\u00e7\u00e3o do sistema.");
});
act("forget-launcher-token", async () => {
  showTokenStatus(await invoke<TokenStatus>("launcher:forget-token"));
  resetLauncherConnection();
  setStatus("Token salvo removido.");
});
for (const role of launcherRoles) {
  const choice = field<HTMLSelectElement>(role + "-models");
  const remember = async () => {
    if (!choice.value) return;
    launcherChoice[role] = choice.value;
    await invoke("app:settings", {launcher_models: {...launcherChoice}});
  };
  choice.addEventListener("change", () => { void remember().catch(error => setStatus(error.message, true)); });
  for (const action of ["start", "stop"] as const) {
    act(action + "-" + role, async () => {
      launcherFailures.delete(role);
      launcherPending.set(role, action);
      launcherStatus(role, action === "start" ? "Carregando" : "Parando");
      repaintControls();
      setStatus(action === "start" ? "Aguardando o modelo carregar\u2026" : "Parando o servidor\u2026");
      try {
        if (action === "start") await remember();
        await control(action, role);
        launcherPending.delete(role);
        displayLauncher(launcher);
        setStatus("Estado do Launcher atualizado.");
      } catch (error) {
        launcherPending.delete(role);
        const label = action === "start" ? "Falha ao iniciar" : "Falha ao parar";
        launcherFailures.set(role, {label, detail: (error as Error).message});
        launcherStatus(role, label, true);
        repaintControls();
        throw error;
      }
    });
  }
}
act("quit-launcher", async () => {
  if (window.confirm("Encerrar o Launcher e os servidores ativos?")) {
    if (await control("quit")) resetLauncherConnection();
    setStatus("Encerramento solicitado ao Launcher.");
  }
});
act("verify-launcher", async () => {
  const [chat, decider] = await invoke<[Health, Health]>("launcher:health", {chat: numeric("chat-port"), decider: numeric("decider-port")});
  if (!launcherPending.has("chat")) launcherStatus("chat", chat.label, !chat.ok);
  if (!launcherPending.has("decider")) launcherStatus("decider", decider.label, !decider.ok);
  const failed = !chat.ok || !decider.ok;
  setStatus(failed ? "Falha em uma ou mais conex\u00f5es locais." : "Conex\u00f5es locais verificadas.", failed);
});
const reviewerInput = () => ({port: numeric("launcher-reviewer-port") ?? 8081, model: value("launcher-reviewer-model")});
for (const id of ["launcher-reviewer-port", "launcher-reviewer-model"]) {
  field(id).addEventListener("input", () => setText("launcher-reviewer-status", "Status não verificado"));
}
act("launcher-reviewer-search", async () => {
  const input = reviewerInput();
  await pickModel("Revisor local", input.model, () => invoke("launcher:reviewer-models", input), id => {
    if (input.port !== reviewerInput().port) return;
    field<HTMLInputElement>("launcher-reviewer-model").value = id;
    setText("launcher-reviewer-status", "Modelo selecionado");
  });
});
act("launcher-reviewer-test", async () => {
  const input = reviewerInput();
  if (!input.model) {
    setText("launcher-reviewer-status", "Informe o ID do modelo.", true);
    return;
  }
  setText("launcher-reviewer-status", "Testando com dados fictícios…");
  try {
    const result = await invoke<ModelOutcome>("model:test", {model: {provider: "launcher", ...input}});
    if (JSON.stringify(reviewerInput()) === JSON.stringify(input)) {
      setText("launcher-reviewer-status", modelStatusText(result), result.status !== "connected");
    }
  } catch (error) {
    if (JSON.stringify(reviewerInput()) === JSON.stringify(input)) setText("launcher-reviewer-status", (error as Error).message, true);
  }
});
act("launcher-reviewer-save", async () => {
  const saved = await invoke<{launcher_reviewer: typeof localReviewer}>("app:settings", {launcher_reviewer: reviewerInput()});
  localReviewer = saved.launcher_reviewer;
  refreshAnalysisChoices();
  setStatus(localReviewer?.model ? "Revisor local salvo. Selecione-o em Analisar aplicação." : "Seleção do Revisor local removida.");
});

const date = (timestamp?: string) => timestamp && Number.isFinite(Date.parse(timestamp)) ?
  new Intl.DateTimeFormat("pt-BR", {dateStyle: "short", timeStyle: "short"}).format(new Date(timestamp)) : "—";
type MonitorStatus = import("./monitor-types").MonitorStatus;
type MonitorRun = MonitorStatus["runs"][number];
let knownRepos: string[] = [];
let chosenRepos = new Set<string>();
let monitorInitialized = false;
const monitorDate = field<HTMLInputElement>("monitor-start");
const monitorRefresh = field<HTMLInputElement>("monitor-refresh");
const monitorRefreshHours = field<HTMLInputElement>("monitor-refresh-hours");
monitorRefresh.addEventListener("change", () => { monitorRefreshHours.disabled = !monitorRefresh.checked; });
const localTime = (time: Date) => new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
monitorDate.value = localTime(new Date());

function renderRepos() {
  const all = checked("monitor-all");
  field("monitor-scope").hidden = all;
  if (all) return;
  const term = value("monitor-filter").toLowerCase();
  const repos = [...new Set([...knownRepos, ...chosenRepos])].filter(repo => repo.toLowerCase().includes(term));
  field("monitor-repos").replaceChildren(...repos.map(repo => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = chosenRepos.has(repo);
    label.className = "check";
    label.append(input, repo);
    input.addEventListener("change", () => { if (input.checked) chosenRepos.add(repo); else chosenRepos.delete(repo); });
    return label;
  }));
}
field("monitor-filter").addEventListener("input", renderRepos);
field("monitor-all").addEventListener("change", renderRepos);

function monitorSummary(run: MonitorRun) {
  const added = run.repos.reduce((total, repo) => total + (repo.added ?? 0), 0);
  const failures = run.repos.filter(repo => repo.error).length;
  const partial = run.repos.filter(repo => repo.partial).length;
  return {added, failures, partial, text: `${run.repos.length} reposit\u00f3rio(s) \u00b7 ${added} novo(s) achado(s) \u00b7 ${failures} falha(s) \u00b7 ${partial} parcial(is)`};
}

function displayMonitor(state: MonitorStatus, reset = false) {
  const {config, next, runs, running} = state;
  if (config && (!monitorInitialized || reset)) {
    field<HTMLInputElement>("monitor-all").checked = config.scope === "all";
    monitorRefresh.checked = config.refresh;
    monitorRefreshHours.disabled = !config.refresh;
    monitorRefreshHours.value = String(config.refreshHours);
    field<HTMLSelectElement>("monitor-period").value = config.period;
    monitorDate.value = localTime(new Date(config.start));
    chosenRepos = new Set(config.repos);
    renderRepos();
  }
  monitorInitialized = true;
  if (config) setText("monitor-account", "GitHub \u00b7 " + config.login);
  field<HTMLButtonElement>("monitor-run").disabled = running || !config;
  field<HTMLButtonElement>("monitor-pause").disabled = running || !config?.enabled;
  setText("monitor-next", running ? "Execu\u00e7\u00e3o em andamento." :
    next ? "Pr\u00f3xima execu\u00e7\u00e3o prevista em " + date(next) : config ? "Agendamento pausado." : "Agendamento ainda n\u00e3o configurado.");
  if (!runs.length) return;
  const latest = monitorSummary(runs[0]);
  field("monitor-alert").hidden = !latest.added;
  setText("monitor-alert", `${latest.added} novo(s) achado(s)`, Boolean(latest.added));
  field("monitor-history").replaceChildren(...runs.map(run => {
    const detail = document.createElement("details");
    const summary = document.createElement("summary");
    const report = monitorSummary(run);
    summary.textContent = date(run.started) + " \u00b7 " + report.text +
      (run.finished ? "" : running ? " \u00b7 em andamento" : " \u00b7 interrompido");
    detail.append(summary);
    for (const warning of run.warnings) {
      const element = document.createElement("p");
      element.dataset.error = "true";
      element.textContent = warning;
      detail.append(element);
    }
    for (const repo of run.repos) {
      const row = document.createElement("div");
      const status = document.createElement("span");
      row.className = "section-head monitor-row";
      status.textContent = repo.repo + " \u00b7 " + (repo.error ??
        `${repo.findings} achado(s), ${repo.added} novo(s)${repo.partial ? " \u00b7 cobertura parcial" : ""}`);
      if (repo.error) status.dataset.error = "true";
      row.append(status);
      if (repo.report) {
        const button = document.createElement("button");
        button.textContent = "Mostrar arquivo";
        button.addEventListener("click", () => {
          void invoke("monitor:open-report", {id: run.id, repo: repo.repo}).catch(error => setStatus(error.message, true));
        });
        row.append(button);
      }
      detail.append(row);
    }
    return detail;
  }));
}
async function refreshMonitor() { displayMonitor(await invoke<MonitorStatus>("monitor:status")); }
act("monitor-load", async () => {
  const result = await githubRepositories();
  knownRepos = result.repos;
  setText("monitor-account", "GitHub \u00b7 " + result.login);
  renderRepos();
  setStatus(`${knownRepos.length} reposit\u00f3rio(s) dispon\u00edveis.`);
});
act("monitor-save", async () => {
  if (!monitorDate.reportValidity() || (monitorRefresh.checked && !monitorRefreshHours.reportValidity())) return;
  displayMonitor(await invoke<MonitorStatus>("monitor:save", {enabled: true,
    scope: checked("monitor-all") ? "all" : "selected", repos: [...chosenRepos],
    period: value("monitor-period"), start: new Date(monitorDate.value).toISOString(), refresh: monitorRefresh.checked,
    refreshHours: monitorRefresh.checked ? monitorRefreshHours.valueAsNumber : undefined,
  }), true);
  setStatus("Agendamento do GitHub ativado.");
});
act("monitor-pause", async () => {
  displayMonitor(await invoke<MonitorStatus>("monitor:save", {enabled: false}));
  setStatus("Monitoramento pausado.");
});
act("monitor-run", async () => { displayMonitor(await invoke<MonitorStatus>("monitor:run")); });
window.deptriagem.onMonitor((event, payload) => {
  if (event === "open") showPage("monitor");
  if (event === "changed" || event === "error") {
    operations.get("monitor")?.remove();
    operations.delete("monitor");
    field("operations").hidden = !operations.size;
  }
  if (event === "changed") {
    const run = payload as MonitorRun;
    const result = monitorSummary(run);
    setStatus(result.text, Boolean(result.added || result.failures || run.warnings.length));
    void refreshMonitor().catch(error => setStatus(error.message, true));
  }
  if (event === "error") setStatus(String(payload), true);
  if (event === "progress") {
    if (!operations.has("monitor")) {
      const article = document.createElement("article");
      article.className = "operation";
      operations.set("monitor", article);
      field("operations").append(article);
      field("operations").hidden = false;
    }
    showProgress("monitor", payload as Progress);
  }
});
async function loadCatalogs() {
  const data = await invoke<Record<string, Catalog | null>>("catalog:status", {path: value("catalog-path")});
  field("catalog-rows").replaceChildren(...["npm", "PyPI", "NuGet", "KEV"].map(name => {
    const entry = data[name], row = document.createElement("tr");
    const control = entry?.positive_control;
    for (const text of [name === "KEV" ? "CISA KEV" : "OSV · " + name,
      entry ? date(entry.source_updated_at) : "Sem catálogo local", date(entry?.downloaded_at),
      control ? `Validado · ${control.advisory} · ${date(control.verified_at)}` : name === "KEV" || !entry ? "—" : "Aguardando validação"]) {
      const cell = document.createElement("td"); cell.textContent = text; row.append(cell);
    }
    return row;
  }));
}
act("save-settings", async () => { await invoke("app:settings", settingsInput()); await loadCatalogs(); setStatus("Configurações salvas."); });
act("get-scanner", async () => {
  setStatus("Baixando e conferindo o OSV-Scanner oficial…");
  const result = await invoke<{path: string; version: string}>("catalog:install");
  field<HTMLInputElement>("scanner-path").value = result.path;
  await invoke("app:settings", settingsInput());
  setStatus(`OSV-Scanner ${result.version} instalado com SHA-256 verificado.`);
});
act("check-scanner", async () => {
  const result = await invoke<{version: string}>("catalog:scanner", {path: value("scanner-path")});
  setStatus(`OSV-Scanner ${result.version} disponível.`);
});
act("reload-catalogs", async () => { await loadCatalogs(); setStatus("Datas dos catálogos recarregadas."); });
for (const id of ["sync-all", "sync-one"]) act(id, async () => {
  setStatus("Baixando e validando os catálogos…");
  const outcome = await invoke<Record<string, {status: string; error?: string}>>("catalog:sync", {
    path: value("catalog-path"), scanner: value("scanner-path"),
    source: id === "sync-one" ? value("catalog-source") : undefined,
  });
  await loadCatalogs();
  const errors = Object.entries(outcome).flatMap(([name, item]) => item.error ? [`${name}: ${item.error}`] : []);
  setStatus(errors.length ? errors.join(" · ") : "Catálogos atualizados.", !!errors.length);
});

interface LastInstall {phase: string; version: string; reason?: string; exit_code?: number}
async function showLastInstall() {
  const previous = await invoke<LastInstall | null>("update:last-install");
  const details: Record<string, string> = {
    closing: "o DepTriagem n\u00e3o encerrou a tempo", hash: "o SHA-256 do pacote divergiu",
    installer: "o instalador foi cancelado ou retornou erro", version: "a vers\u00e3o instalada divergiu",
    reopen: "a reabertura da janela falhou", helper: "o processo de atualiza\u00e7\u00e3o n\u00e3o iniciou",
  };
  field("last-update-result").hidden = !previous;
  if (!previous) return;
  const prefix = "Atualiza\u00e7\u00e3o " + previous.version + " \u00b7 ";
  if (previous.phase === "failed") {
    const code = previous.exit_code ? ` (c\u00f3digo ${previous.exit_code})` : "";
    setText("last-update-result", prefix + (details[previous.reason ?? ""] ?? "falhou") + code + ".", true);
  } else setText("last-update-result", prefix + (previous.phase === "complete" ? "vers\u00e3o conferida." : "iniciada."));
}

let checking = false;
async function checkUpdate() {
  if (checking) return;
  checking = true;
  availableUpdate = false;
  repaintControls();
  setText("update-status", "Consultando as releases do DepTriagem…");
  void showLastInstall().catch(error => setStatus(error.message, true));
  try {
    const item = await invoke<UpdateInfo>("update:check");
    availableUpdate = item.status === "available";
    field("update-badge").hidden = !availableUpdate;
    setText("update-status", ({
      current: "Você já está na versão atual.", no_release: "O repositório ainda não tem uma versão estável publicada.",
      available: `Versão ${item.version} disponível desde ${date(item.published_at)}.`,
      asset_unavailable: `Versão ${item.version} publicada, sem instalador verificável.`,
    } as Record<string, string>)[item.status] || "Estado da atualização desconhecido.");
    field("update-notes-card").hidden = !item.notes;
    setText("update-notes", item.notes || "");
  } catch (error) { setText("update-status", (error as Error).message, true); }
  finally { checking = false; repaintControls(); }
}
act("check-update", checkUpdate);
act("apply-update", async () => {
  setText("update-status", "Baixando e conferindo o SHA-256…");
  const info = await invoke<{asset: string; canInstall: boolean}>("update:download");
  setText("update-status", "Instalador verificado: " + info.asset);
  if (info.canInstall && !await invoke<boolean>("update:install")) {
    setText("update-status", "Instala\u00e7\u00e3o cancelada. O pacote foi baixado e verificado.");
  }
});
act("release-site", async () => { await invoke("update:open-release"); });
field("automatic-update").addEventListener("change", () => {
  void invoke("app:settings", {update_check: checked("automatic-update")}).catch(error => setStatus(error.message, true));
});

for (const name of ["usage", "integration", "diagnostics"]) {
  act("manual-" + name, async () => { await invoke("manual:open", {name}); });
}
act("copy-diagnostics", async () => {
  await invoke("diagnostics:copy");
  setStatus("Diagn\u00f3stico copiado.");
});

async function initialize() {
  const state = await invoke<{version: string; dark: boolean; platform: string; modelEfforts?: Record<string, string[]>; modelListings?: string[]; settings: {theme?: string; catalog_dir?: string;
    scanner?: string; reports_dir?: string; models?: ModelChoices; launcher_models?: Partial<Record<Role, string>>;
    triage_decider?: DeciderChoice; launcher_reviewer?: {model?: string; port?: number}; update_check?: boolean}}>("app:state");
  setText("version", "· v" + state.version);
  if (state.platform !== "win32") setText("apply-update", "Baixar pacote verificado");
  else setText("monitor-platform-note", "Fechar a janela mant\u00e9m o monitor ativo na bandeja. Para interromper, pause o agendamento ou saia do DepTriagem.");
  setText("installed-version", "DepTriagem " + state.version);
  dark = state.dark;
  Object.assign(launcherChoice, state.settings.launcher_models);
  availableEfforts = state.modelEfforts ?? {};
  modelListings = state.modelListings ?? [];
  if (state.settings.models) for (const role of Object.keys(modelRoles) as ModelRole[]) {
    const choice = state.settings.models[role];
    controlFor<HTMLSelectElement>(role, "provider").value = choice.provider;
    controlFor<HTMLSelectElement>(role, "provider").dataset.previous = choice.provider;
    controlFor<HTMLInputElement>(role, "model").value = choice.model ?? "";
    renderEffort(role, choice.provider, choice.effort ?? "");
  }
  if (state.settings.models) savedModels = state.settings.models;
  localReviewer = state.settings.launcher_reviewer;
  field<HTMLInputElement>("launcher-reviewer-port").value = String(localReviewer?.port ?? 8081);
  field<HTMLInputElement>("launcher-reviewer-model").value = localReviewer?.model ?? "";
  for (const role of Object.keys(modelRoles) as ModelRole[]) projectProvider(role).selectedIndex = -1;
  availableKeys = await invoke("model:credentials");
  refreshModels();
  theme = ({Sistema: "system", Claro: "light", Escuro: "dark"} as Record<string, Theme>)[state.settings.theme || ""] ||
    (state.settings.theme as Theme) || "system";
  field<HTMLSelectElement>("theme").value = theme;
  field<HTMLInputElement>("catalog-path").value = state.settings.catalog_dir || "";
  field<HTMLInputElement>("scanner-path").value = state.settings.scanner || "";
  field<HTMLInputElement>("reports-path").value = state.settings.reports_dir || "";
  const decider = state.settings.triage_decider;
  if (decider && (["launcher", "systemone", "chat"].includes(decider.mode) || deciderUsesModel(decider.mode))) {
    savedDecider = decider;
    field<HTMLSelectElement>("triage-decider-mode").value = decider.mode;
    if (decider.mode === "chat") {
      field<HTMLInputElement>("triage-chat-port").value = String(decider.port ?? 8080);
      field<HTMLInputElement>("triage-chat-model").value = decider.model ?? "";
    } else if (decider.mode === "systemone") {
      field<HTMLInputElement>("triage-systemone-port").value = String(decider.port ?? 8090);
    } else if (deciderUsesModel(decider.mode)) {
      field<HTMLInputElement>("triage-opencode-model").value = decider.model ?? "";
      field<HTMLInputElement>("triage-opencode-port").value = String(decider.port ?? 8080);
    }
  }
  refreshTriageDecider();
  if (decider?.effort) showDeciderEfforts(decider.model, decider.effort);
  refreshTriageSelection(true);
  field<HTMLInputElement>("automatic-update").checked = state.settings.update_check !== false;
  applyTheme(); showPage("projects"); repaintControls();
  await Promise.all([loadCatalogs(), showLastInstall(), invoke<TokenStatus>("launcher:token-status").then(showTokenStatus),
    refreshGithubAccount()]);
  if (checked("automatic-update")) void checkUpdate();
  setInterval(() => { if (checked("automatic-update")) void checkUpdate(); }, 86400000);
}
void initialize().catch(error => setStatus(error.message, true));
