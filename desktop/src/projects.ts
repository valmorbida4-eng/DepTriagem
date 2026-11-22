import {copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, relative, resolve} from "node:path";
import {tmpdir} from "node:os";
import {catalogDir, kevIds, scanner, sha256, snapshot, type Kev, type Source, type Snapshot} from "./catalogs";
import {archive} from "./zip";
import {github, json, run} from "./system";
import type {ReportProgress} from "./progress";
import type {Chat, DeciderConfig, ReviewerSource} from "./launcher";
import {decideAnalysis, modelGuidance, type ModelPlan, type Provider} from "./models";
import {cachedAdvisories, findingDetails, type Advisory} from "./advisories";
import {findGitFolder, isolatedGit, resolveLocalFolder} from "./git-inventory";

const locks = new Map<string, Source>([
  ...["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"].map(name => [name, "npm"] as const),
  ...["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "pylock.toml"].map(name => [name, "PyPI"] as const),
  ["packages.lock.json", "NuGet"],
]);
const manifest = new Map(Object.entries({"package.json": "npm", "pyproject.toml": "PyPI", Pipfile: "PyPI",
  "pom.xml": "Maven", "Cargo.lock": "crates.io", "go.mod": "Go", "Gemfile.lock": "RubyGems", "composer.lock": "Packagist"}));
const skip = new Set([".git", ".venv", "venv", "node_modules", "__pycache__"]);
const isRequirements = (path: string) => /^(?:.*[-_.])?requirements[^/]*\.txt$/i.test(basename(path)) ||
  /(?:^|\/)requirements\/[^/]+\.txt$/i.test(path);
const lockEcosystem = (path: string) => isRequirements(path) ? "PyPI" as const : locks.get(basename(path));
const languages = new Map(Object.entries({".py": "Python", ".js": "JavaScript", ".ts": "TypeScript", ".cs": "C#",
  ".java": "Java", ".go": "Go", ".rs": "Rust", ".php": "PHP", ".rb": "Ruby"}));
const ecosystems = new Map(Object.entries({Python: "PyPI", JavaScript: "npm", TypeScript: "npm", "C#": "NuGet"}));
export interface AnalyzeInput {
  kind: "local" | "github"; target: string; ref?: string; commit?: string; catalog_dir?: string; scanner?: string;
  guidance?: Chat;
  expectedAccount?: string;
  models?: ModelPlan;
  reviewerLauncher?: {source: ReviewerSource; model: string; port: number};
  decider?: DeciderConfig;
  allowExternal?: boolean;
  credentials?: Partial<Record<Provider, string>>;
}
interface FileSource { path: string; read?(limit: number): Promise<Buffer>; gap?: string }
interface Lock { path: string; ecosystem: Source; sha256: string; file: string; status: string }
interface Package {name: string; version: string; ecosystem: string}
interface Result {
  source: {path: string}; packages?: {package: Package; vulnerabilities?: Advisory[] | null}[];
}
interface Scan {results?: Result[] | null}

const normalized = (name: string) => name.replaceAll("\\", "/");
const parentName = (name: string) => normalized(dirname(name));

export async function account() {
  return (await github<{login: string}>("user")).login;
}

export async function repositories() {
  const login = await account();
  const repos = new Set<string>();
  for (let page = 1; ; page++) {
    const list = await github<{full_name: string}[]>(`user/repos?per_page=100&sort=full_name&page=${page}`);
    for (const item of list) repos.add(item.full_name);
    if (list.length < 100) return {login, repos: [...repos]};
  }
}

export function repoName(value: string) {
  let clean = value.trim().replace(/\/$/, "");
  if (clean.startsWith("https://github.com/")) clean = clean.slice("https://github.com/".length);
  clean = clean.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(clean) || /\/(?:\.|\.\.)$/.test(clean)) {
    throw new Error("Informe o repositório como dono/nome ou URL do GitHub.com.");
  }
  return clean;
}

export async function* localFiles(root: string, includeIgnored = false): AsyncGenerator<FileSource> {
  const repo = await findGitFolder(root);
  if (!repo) {
    yield* walkFiles(root, root, includeIgnored);
    return;
  }
  if (!repo.supported) {
    if (includeIgnored) yield {path: ".", gap: "git_metadata_not_inspected"};
    yield* walkFiles(root, root, includeIgnored);
    return;
  }
  const scope = await isolatedGit(repo.root, root, false);
  const outputPaths = (buffer: Buffer) => buffer.toString("utf8").split("\0").filter(Boolean);
  const within = (path: string) => scope.prefix
    ? path.startsWith(scope.prefix + "/") ? path.slice(scope.prefix.length + 1) : "" : path;
  try {
    const indexed = await scope.git(["ls-files", "--stage", "--sparse", "-t", "-z"], 32 * 1024 ** 2);
    if (indexed.code) throw new Error("O Git não conseguiu ler o índice do projeto.");
    if (includeIgnored && (indexed.diagnostics.trim() || !scope.ignoresComplete)) yield {path: ".", gap: "git_metadata_not_inspected"};
    const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
    // For coverage gaps, preserve distinct Unicode names even on Windows.
    const sparseKey = (path: string) => process.platform === "win32"
      ? path.replace(/[A-Z]/g, letter => letter.toLowerCase()) : path;
    const tracked = new Set<string>();
    const nested = new Set<string>();
    const sparse = new Map<string, string>();
    for (const line of outputPaths(indexed.output)) {
      const match = /^(\S) (\d+) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(line);
      const path = match && ((scope.prefix && match[3] === scope.prefix + "/") ? "." : within(match[3]));
      if (!path || !match) continue;
      tracked.add(pathKey(path));
      if (match[1] === "S" && match[2] !== "040000") sparse.set(sparseKey(path), path);
      if (match[2] === "160000" || match[2] === "040000") {
        nested.add(path.replace(/\/$/, ""));
        if (includeIgnored) yield {path, gap: match[2] === "160000" ? "nested_repository" : "git_metadata_not_inspected"};
      }
    }
    const pending: FileSource[] = [];
    const absoluteGitPath = (path: string) => scope.prefix ? scope.prefix + "/" + path : path;
    let pendingBytes = 0;
    const probePaths = async (paths: string[]) => {
      if (!paths.length) return {ignored: new Set<string>(), partial: false};
      const probe = await scope.git(["check-ignore", "--no-index", "--stdin", "-z"], 4 * 1024 ** 2,
        paths.map(path => "./" + absoluteGitPath(path)).join("\0") + "\0");
      const ignored = new Set(outputPaths(probe.output).map(path => path.replace(/^\.\//, "")).map(within));
      return {ignored, partial: Boolean(probe.diagnostics.trim()) || ![0, 1].includes(probe.code)};
    };
    async function* verifyIgnores() {
      if (!pending.length) return;
      const files = await probePaths(pending.map(file => file.path));
      if (includeIgnored && files.partial) yield {path: ".", gap: "git_metadata_not_inspected"};
      pendingBytes = 0;
      for (const file of pending.splice(0)) {
        if (!files.ignored.has(file.path)) yield file;
        else if (includeIgnored && lockEcosystem(file.path)) yield {path: file.path};
      }
    }
    for await (const file of walkFiles(root, root, includeIgnored, nested, scope.addIgnore)) {
      if (file.read) sparse.delete(sparseKey(file.path));
      if (file.gap) yield file;
      else if (includeIgnored && !inventoryPath(file.path)) continue;
      else if (tracked.has(pathKey(file.path))) yield file;
      else {
        pendingBytes += Buffer.byteLength(absoluteGitPath(file.path)) + 3;
        pending.push(file);
      }
      if (pending.length >= 32768 || pendingBytes >= 2 * 1024 ** 2) yield* verifyIgnores();
    }
    yield* verifyIgnores();
    if (includeIgnored) for (const path of sparse.values()) yield {path, gap: "git_metadata_not_inspected"};
  } finally { await scope.dispose(); }
}

async function committedFiles(root: string, ref: string) {
  const repo = await findGitFolder(root);
  if (!repo?.supported) throw new Error("A análise de commit exige um repositório Git local com pasta .git própria.");
  const scope = await isolatedGit(repo.root, root, true);
  const {git, dispose} = scope;
  try {
    const result = await git(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).catch(() => undefined);
    const commit = result?.output.toString().trim() ?? "";
    const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
    if (result?.code !== 0 || !objectId.test(commit)) throw new Error("Não foi possível resolver o commit Git local.");
    const treeResult = await git(["rev-parse", commit + "^{tree}"]);
    const prefix = scope.prefix ? scope.prefix + "/" : "";
    const tree = treeResult.output.toString().trim();
    if (treeResult.code || !objectId.test(tree)) throw new Error("Não foi possível ler a árvore do commit Git local.");
    const listing = await git(["ls-tree", "-rz", "--full-tree", tree], 32 * 1024 ** 2);
    if (listing.code) throw new Error("Não foi possível inventariar o commit Git local.");
    function* files(): Iterable<FileSource> {
      for (const entry of listing.output.toString("utf8").split("\0")) {
        const match = /^(100644|100755|160000) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
        if (!match || !objectId.test(match[2]) || !match[3].startsWith(prefix)) continue;
        const path = match[3].slice(prefix.length);
        const parts = path.toLowerCase().split("/");
        if (!path || /[\\:\x00-\x1f\x7f\ufffd]/.test(path) ||
            parts.some(part => !part || part === "." || part === ".." || skip.has(part)) ||
            parts.join("/").startsWith(".claude/worktrees/")) continue;
        if (match[1] === "160000") {
          yield {path, gap: "nested_repository"};
          continue;
        }
        yield {path, async read(limit) {
          const blob = await git(["cat-file", "blob", match[2]], limit);
          if (blob.code) throw new Error("Não foi possível ler um arquivo do commit Git local.");
          return blob.output;
        }};
      }
    }
    return {commit, tree, files: files(), dispose};
  } catch (error) {
    await dispose();
    throw error;
  }
}

const extensionOf = (name: string) => name.match(/\.[^.]+$/)?.[0] || "";
const inventoryPath = (path: string) => {
  const name = basename(path);
  const extension = extensionOf(name);
  return Boolean(lockEcosystem(path) || languages.has(extension) || manifest.has(name) || /\.(?:cs|fs|vb)proj$/.test(extension));
};

async function* walkFiles(root: string, folder: string, reportGaps = false, nested = new Set<string>(),
  addIgnore?: (folder: string, name?: string) => Promise<boolean>): AsyncGenerator<FileSource> {
  const entries = await readdir(folder, {withFileTypes: true, encoding: "buffer"}).catch(() => undefined);
  if (!entries) {
    if (reportGaps) yield {path: normalized(relative(root, folder)) || ".", gap: "git_metadata_not_inspected"};
    return;
  }
  if (folder !== root && addIgnore) {
    const ignore = entries.find(entry => entry.name.toString() === ".gitignore") ??
      (process.platform === "win32" ? entries.find(entry => entry.name.toString().toLowerCase() === ".gitignore") : undefined);
    if (ignore && !await addIgnore(folder, ignore.name.toString()) && reportGaps) {
      yield {path: normalized(relative(root, folder)) || ".", gap: "git_metadata_not_inspected"};
    }
  }
  for (const entry of entries) {
    const name = entry.name.toString();
    if (!Buffer.from(name).equals(entry.name)) {
      if (reportGaps) yield {path: normalized(relative(root, folder)) || ".", gap: "git_metadata_not_inspected"};
      continue;
    }
    const location = join(folder, name);
    const path = normalized(relative(root, location));
    if (entry.isSymbolicLink()) {
      if (reportGaps) yield {path, gap: "linked_path_skipped"};
      continue;
    }
    if (skip.has(name.toLowerCase())) continue;
    if (entry.isDirectory()) {
      if (path.toLowerCase() === ".claude/worktrees" || nested.has(path)) continue;
      const info = await lstat(location).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        if (reportGaps) yield {path, gap: "linked_path_skipped"};
        continue;
      }
      if (await lstat(join(location, ".git")).then(() => true, () => false)) {
        if (reportGaps) yield {path, gap: "nested_repository"};
        continue;
      }
      yield* walkFiles(root, location, reportGaps, nested, addIgnore);
    } else if (entry.isFile()) {
      yield {path, async read(limit) {
        const file = await open(location);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > limit) throw new Error("Arquivo acima do limite.");
          const data = await file.readFile();
          if (data.length > limit) throw new Error("Arquivo acima do limite.");
          return data;
        } finally { await file.close(); }
      }};
    }
  }
}

async function inventory(files: Iterable<FileSource> | AsyncIterable<FileSource>, stage: string) {
  const detected: Record<string, number> = {};
  const imports: Record<string, Set<string>> = {};
  const declared = new Map<string, string>();
  const result: Lock[] = [];
  const ignored: {reason: string; path: string; ecosystem?: Source}[] = [];
  const paths = new Set<string>();
  let sampled = 0;
  for await (const file of files) {
    const name = basename(file.path), extension = extensionOf(name);
    const eco = lockEcosystem(file.path);
    if (!file.read) {
      if (file.gap || eco) ignored.push({reason: file.gap || "lockfile_ignored_by_git", path: file.path, ecosystem: eco});
      continue;
    }
    const language = languages.get(extension);
    if (language) {
      detected[language] = (detected[language] || 0) + 1;
      if (ecosystems.has(language) && sampled++ < 600) {
        const text = (await file.read(128 * 1024).catch(() => Buffer.alloc(0))).toString();
        const pattern = language === "Python" ? /^[ \t]*(?:from|import)[ \t]+([a-zA-Z_]\w*)/gm : language === "C#" ?
          /^[ \t]*(?:global[ \t]+)?using[ \t]+([a-zA-Z_]\w*)/gm :
          /(?:\bfrom[ \t]+|^[ \t]*import[ \t]+|\b(?:require|import)\([ \t]*)['"]((?:@[\w.-]+\/)?[\w-][\w.-]*)(?=[/'"])/gm;
        const hints = imports[language] ||= new Set();
        for (const match of text.matchAll(pattern)) if (hints.size < 35) hints.add(match[1]);
      }
    }
    const declaredEco = manifest.get(name) || (/\.(?:cs|fs|vb)proj$/.test(extension) ? "NuGet" : undefined);
    if (declaredEco) declared.set(parentName(file.path) + "\0" + declaredEco, declaredEco);
    if (!eco) continue;
    if (paths.has(file.path.toLowerCase()) || result.length >= 250) throw new Error("Inventário com arquivos duplicados ou mais de 250 lockfiles.");
    paths.add(file.path.toLowerCase());
    const data = await file.read(12 * 1024 ** 2).catch(() => undefined);
    if (!data) {
      ignored.push({reason: "git_metadata_not_inspected", path: file.path, ecosystem: eco});
      continue;
    }
    const requirements = isRequirements(file.path) ? data.toString().split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith("#")) : undefined;
    const pinned = !requirements || (requirements.length && requirements.every(
      line => /^[\w.-]+(?:\[[^\]]+\])?\s*==\s*[\w.+!\-]+(?:\s*(?:;|#).*)?$/.test(line)));
    const target = join(stage, String(result.length), requirements ? "requirements.txt" : name);
    if (pinned) {
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, data);
    }
    result.push({path: file.path, ecosystem: eco, sha256: sha256(data), file: target,
      status: pinned ? "pending" : "not_fully_pinned"});
  }
  return {detected, declared, hints: Object.fromEntries(Object.entries(imports).map(([key, names]) => [key, [...names]])), result, ignored};
}

export function summarize(osv: Scan, kev?: Kev, maxAge = 14, metadata = new Map<Source, Map<string, Advisory>>()) {
  if (!Array.isArray(osv?.results)) throw new Error("O JSON do OSV-Scanner precisa conter results.");
  const ids = kev ? kevIds(kev) : new Set<string>();
  const age = kev ? Math.floor((Date.now() - Date.parse(kev.dateReleased)) / 86400000) : Infinity;
  const current = age >= 0 && age <= maxAge;
  let count = 0;
  const findings = [];
  const seen = new Set<string>();
  for (const source of osv.results) for (const record of source.packages || []) {
    const pkg = record.package;
    if (typeof pkg?.name !== "string" || typeof pkg?.version !== "string" || typeof pkg?.ecosystem !== "string") {
      throw new Error("Pacote sem identificação de versão ou ecossistema.");
    }
    count++;
    const groups: Set<string>[] = [];
    for (const item of record.vulnerabilities || []) {
      if (!item.id || typeof item.id !== "string") throw new Error("Advisory sem identificador.");
      const joined = new Set([item.id, ...(item.aliases || [])]);
      for (let index = groups.length - 1; index >= 0; index--) {
        if ([...groups[index]].some(id => joined.has(id))) {
          for (const id of groups[index]) joined.add(id);
          groups.splice(index, 1);
        }
      }
      groups.push(joined);
    }
    for (const group of groups) {
      const aliases = [...group].sort();
      const key = JSON.stringify([source.source.path, pkg.ecosystem, pkg.name, pkg.version, aliases]);
      if (seen.has(key)) continue;
      seen.add(key);
      const exploited = aliases.filter(id => ids.has(id));
      const sources = new Map((record.vulnerabilities ?? []).filter(item => group.has(item.id) && !item.withdrawn)
        .map(item => [item.id, item]));
      for (const id of aliases) {
        const published = metadata.get(pkg.ecosystem as Source)?.get(id);
        if (published) sources.set(id, {...sources.get(id), ...published});
      }
      findings.push({...pkg, source: source.source.path, ids: aliases, kev: exploited,
        ...findingDetails([...sources.values()], pkg),
        priority: current && exploited.length ? "maximum" : "manual_review"});
    }
  }
  return {packages_reported: count, findings, kev_date: kev?.dateReleased.slice(0, 10) ?? null,
    kev_status: current ? "current" : kev ? "stale_or_future" : "missing"};
}

export async function review(osv: string, kev: string, maxAge = 14) {
  return summarize(await json<Scan>(osv), await json<Kev>(kev), maxAge);
}

export async function analyze(input: AnalyzeInput, progress?: ReportProgress) {
  const total = input.decider ? 6 : 5;
  const step = (completed: number, label: string) => progress?.({label, completed, total, unit: "steps"});
  step(0, "Verificando o OSV-Scanner e a origem");
  if (!input.target || !["local", "github"].includes(input.kind)) throw new Error("Selecione a origem do projeto.");
  if (input.commit && input.kind !== "local") throw new Error("A opção de commit local exige uma pasta Git.");
  const tool = await scanner(input.scanner);
  const root = await catalogDir(input.catalog_dir);
  const temp = await mkdtemp(join(tmpdir(), "deptriagem-project-"));
  try {
    const stage = join(temp, "inputs");
    await mkdir(stage);
    let source: Record<string, string>;
    let collected: Awaited<ReturnType<typeof inventory>>;
    if (input.kind === "github") {
      const login = await account();
      if (input.expectedAccount && login.toLowerCase() !== input.expectedAccount.toLowerCase()) {
        throw new Error("A conta do GitHub mudou durante a analise.");
      }
      const repo = repoName(input.target);
      const ref = input.ref || (await github<{default_branch: string}>(`repos/${repo}`)).default_branch;
      const {sha} = await github<{sha: string}>(`repos/${repo}/commits/${encodeURIComponent(ref)}`);
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("O GitHub não retornou um commit válido.");
      source = {kind: "github", repository: repo, requested_ref: ref, commit: sha};
      const destination = join(temp, "project.zip");
      step(1, "Baixando a revisão pelo GitHub CLI");
      const downloaded = await run("gh", ["api", "--hostname", "github.com", `repos/${repo}/zipball/${sha}`],
        {output: destination, limit: 512 * 1024 ** 2, timeout: 180_000});
      if (downloaded.code) throw new Error("Não foi possível baixar o commit selecionado.");
      step(1, "Inventariando os arquivos do repositório");
      collected = await archive(destination, (entries, read) => inventory(entries.flatMap<FileSource>(item => {
        const parts = item.name.split("/").slice(1);
        if (!parts.length || parts.some(part => !part || [".", ".."].includes(part) || skip.has(part)) ||
          /[\\:]/.test(item.name) || ((item.attributes >>> 16) & 0xf000) === 0xa000) return [];
        const path = parts.join("/");
        return basename(path) === ".gitmodules" ? [{path, gap: "nested_repository"}]
          : [{path, read: (limit: number) => read(item, limit)}];
      }), stage));
    } else {
      const folder = await resolveLocalFolder(input.target);
      if (!(await lstat(folder)).isDirectory()) throw new Error("Selecione a pasta da aplicação.");
      source = {kind: "local", directory: basename(folder), revision: "worktree"};
      if (input.commit) {
        step(1, "Lendo os arquivos do commit Git local");
        const fixed = await committedFiles(folder, input.commit);
        source = {...source, revision: "commit", commit: fixed.commit, tree: fixed.tree};
        try { collected = await inventory(fixed.files, stage); }
        finally { await fixed.dispose(); }
      } else {
        step(1, "Inventariando os arquivos da pasta");
        collected = await inventory(localFiles(folder, true), stage);
      }
    }
    step(2, "Preparando os catálogos locais");
    const catalogMeta: Partial<Record<Source, Snapshot | null>> = {};
    const available = new Map<Source, string>();
    for (const name of new Set<Source>([...collected.result.map(item => item.ecosystem), "KEV"])) {
      const value = await snapshot(root, name, true);
      catalogMeta[name] = value?.meta ?? null;
      if (value) available.set(name, value.path);
    }
    for (const item of collected.result) if (item.status === "pending" && !available.has(item.ecosystem)) {
      item.status = "catalog_missing";
      await rm(item.file);
    }
    const eligible = collected.result.filter(item => item.status === "pending");
    const db = join(temp, "db");
    for (const name of new Set(eligible.map(item => item.ecosystem))) {
      const folder = join(db, "osv-scalibr", name);
      await mkdir(folder, {recursive: true});
      await copyFile(available.get(name)!, join(folder, "all.zip"));
    }
    let scanned: Scan = {results: []};
    const issues: {reason: string; path?: string; ecosystem?: string}[] = [...collected.ignored];
    if (eligible.length) {
      step(3, "Aguardando a verificação offline do OSV-Scanner");
      const config = join(temp, "osv-scanner.toml"), output = join(temp, "osv.json");
      await writeFile(config, "# DepTriagem: sem supressões.\n");
      const processResult = await run(tool.executable, ["scan", "source", "--offline", "--no-resolve", "--all-packages",
        "--format", "json", "--config", config, "--output-file", output, "-r", "."],
        {cwd: stage, timeout: 300_000, env: {...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db}});
      if (![0, 1, 128].includes(processResult.code)) throw new Error(`OSV-Scanner falhou com código ${processResult.code}.`);
      if (processResult.code !== 128) scanned = await json<Scan>(output);
      if (/\b(?:warning|error|failed)\b/i.test(processResult.diagnostics)) issues.push({reason: "scanner_reported_diagnostics"});
    }
    step(4, "Consolidando a cobertura e os achados");
    const staged = new Map(eligible.map(item => [resolve(item.file), item]));
    const names = new Map<string, Package>();
    for (const entry of scanned.results || []) {
      const path = entry.source.path, match = staged.get(isAbsolute(path) ? resolve(path) : resolve(stage, path));
      if (!match) throw new Error("O scanner identificou um arquivo fora do inventário.");
      entry.source.path = match.path;
      if (entry.packages?.length) match.status = "scanned";
      for (const item of entry.packages || []) {
        const pkg = item.package;
        if (names.size < 60) names.set(JSON.stringify(pkg), pkg);
      }
    }
    const wanted = new Map<Source, Set<string>>();
    for (const entry of scanned.results ?? []) for (const item of entry.packages ?? []) {
      const eco = item.package.ecosystem as Source;
      if (!available.has(eco) || !item.vulnerabilities?.length) continue;
      const ids = wanted.get(eco) ?? new Set<string>();
      for (const record of item.vulnerabilities) for (const id of [record.id, ...(record.aliases ?? [])]) ids.add(id);
      wanted.set(eco, ids);
    }
    const details = summarize(scanned, available.has("KEV") ? await json<Kev>(available.get("KEV")!) : undefined,
      undefined, await cachedAdvisories(available, wanted));
    const checked = new Set(collected.result.filter(item => item.status === "scanned").map(
      item => parentName(item.path) + "\0" + item.ecosystem));
    for (const [key, eco] of collected.declared) if (!checked.has(key)) {
      issues.push({reason: "manifest_without_scanned_lockfile", path: key.split("\0")[0], ecosystem: eco});
    }
    for (const [language, eco] of ecosystems) if (collected.detected[language] &&
      !collected.result.some(item => item.ecosystem === eco) && ![...collected.declared.values()].includes(eco)) {
      issues.push({reason: "language_without_lockfile", ecosystem: eco});
    }
    if (!details.packages_reported) issues.push({reason: "no_packages_scanned"});
    if (details.kev_status !== "current") issues.push({reason: "kev_" + details.kev_status});
    for (const [name, data] of Object.entries(catalogMeta)) if (name !== "KEV" && data && (
      Date.now() - Date.parse(data.downloaded_at) > 7 * 86400000 ||
      (data.source_updated_at && Date.now() - Date.parse(data.source_updated_at) > 7 * 86400000))) {
      issues.push({reason: "osv_snapshot_needs_refresh", ecosystem: name});
    }
    const lockfiles = collected.result.map(({file: _file, ...item}) => {
      if (item.status === "pending") item.status = "no_packages_reported";
      if (item.status !== "scanned") issues.push({reason: item.status, path: item.path, ecosystem: item.ecosystem});
      return item;
    });
    if (input.guidance || (input.models && (input.models.agent.provider !== "off" || input.models.reviewer.provider !== "off"))) {
      step(4, "Consultando os modelos para orientar a revisão");
    }
    const issueCodes = [...new Set(issues.map(item => item.reason))];
    const coverage = issues.length ? "partial" : "inventory_scanned";
    const guidance = await modelGuidance({
      languages: collected.detected,
      coverage_issues: issueCodes, findings_count: details.findings.length,
    }, input.models ?? (input.guidance ? {agent: {provider: "launcher"}, reviewer: {provider: "off"}} : undefined),
      input.allowExternal, input.credentials, input.guidance && {provider: "launcher", ...input.guidance},
      {import_hints: collected.hints, packages: [...names.values()]});
    let modelDecision: Awaited<ReturnType<typeof decideAnalysis>> | undefined;
    if (input.decider) {
      step(5, "Consultando o Decisor sobre a fila de revisão");
      modelDecision = await decideAnalysis({packages_reported: details.packages_reported,
        findings_count: details.findings.length,
        maximum_priority_count: details.findings.filter(finding => finding.priority === "maximum").length,
        coverage, coverage_issues: issueCodes,
      }, input.decider, input.allowExternal, input.credentials);
    }
    step(total, "Relatório preparado");
    return {...details, schema_version: 1, source, generated_at: new Date().toISOString(), scanner_version: tool.version,
      coverage, coverage_issues: issues,
      inventory: {languages: collected.detected, import_hints: collected.hints, lockfiles},
      catalogs: catalogMeta, model_guidance: input.reviewerLauncher ? {...guidance, reviewer_launcher: input.reviewerLauncher} : guidance,
      ...(modelDecision ? {model_decision: modelDecision} : {})};
  } finally { await rm(temp, {recursive: true, force: true}); }
}

export async function readRelato(path: string) {
  const file = await open(path);
  try {
    if ((await file.stat()).size > 16384) throw new Error("O relato excede 16 KiB.");
    return new TextDecoder("utf-8", {fatal: true}).decode(await file.readFile()).trim();
  } finally { await file.close(); }
}
