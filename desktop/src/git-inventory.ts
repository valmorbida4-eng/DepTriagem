import {copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, parse, relative, resolve, sep} from "node:path";
import {resolveExecutable, run} from "./system";

async function metadata(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function assertLocalFolder(path: string) {
  if (!isAbsolute(path) || (process.platform === "win32" && !/^[a-z]:[/\\]$/i.test(parse(path).root))) {
    throw new Error("Selecione uma pasta em um disco local.");
  }
}

export async function resolveLocalFolder(input: string) {
  const absolute = resolve(input);
  assertLocalFolder(absolute);
  if (absolute === parse(absolute).root) throw new Error("Selecione a pasta específica de um projeto.");
  if (process.platform === "win32") {
    const root = parse(absolute).root;
    let current = root;
    for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, segment);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Selecione uma pasta local sem redirecionamentos.");
    }
  }
  const path = await realpath(absolute);
  assertLocalFolder(path);
  return path;
}

export async function findGitFolder(folder: string) {
  for (let current = folder; ; current = dirname(current)) {
    const marker = await metadata(join(current, ".git"));
    if (marker) {
      if (!marker.isDirectory() || marker.isSymbolicLink()) return {root: current, supported: false};
      const head = await metadata(join(current, ".git", "HEAD"));
      if (head) return {root: current, supported: head.isFile() && !head.isSymbolicLink()};
    }
    if (dirname(current) === current) return undefined;
  }
}

async function copyRegular(from: string, to: string) {
  const info = await metadata(from);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Metadados Git locais contêm um vínculo ou arquivo especial.");
  await copyFile(from, to);
}

async function copyTree(from: string, to: string, accept: (name: string) => boolean) {
  const info = await metadata(from);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Metadados Git locais contêm um vínculo ou arquivo especial.");
  await mkdir(to, {recursive: true});
  for (const entry of await readdir(from, {withFileTypes: true})) {
    if (!accept(entry.name)) continue;
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination, accept);
    else await copyRegular(source, destination);
  }
}

export async function isolatedGit(repo: string, selected: string, includeObjects: boolean) {
  const original = join(repo, ".git");
  const sandbox = await mkdtemp(join(tmpdir(), "deptriagem-git-"));
  const dispose = () => rm(sandbox, {recursive: true, force: true});
  try {
    const worktree = join(sandbox, "worktree");
    await mkdir(worktree);
    await mkdir(join(sandbox, "objects"));
    await mkdir(join(sandbox, "refs"));
    await mkdir(join(sandbox, "info"));
    await copyRegular(join(original, "HEAD"), join(sandbox, "HEAD"));
    await copyRegular(join(original, "packed-refs"), join(sandbox, "packed-refs"));
    await copyTree(join(original, "refs"), join(sandbox, "refs"), name => !name.endsWith(".lock"));
    if (includeObjects) {
      await copyTree(join(original, "objects"), join(sandbox, "objects"), name =>
        /^(?:[0-9a-f]{2}|[0-9a-f]{38}|[0-9a-f]{62}|pack|pack-[0-9a-f]+\.(?:pack|idx))$/.test(name));
    } else {
      await copyRegular(join(original, "index"), join(sandbox, "index"));
      for (const name of await readdir(original)) {
        if (/^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(name)) {
          await copyRegular(join(original, name), join(sandbox, name));
        }
      }
      const info = await metadata(join(original, "info"));
      if (info?.isDirectory() && !info.isSymbolicLink()) {
        await copyRegular(join(original, "info", "exclude"), join(sandbox, "info", "exclude"));
      }
    }
    const sourceConfig = join(original, "config");
    const info = await metadata(sourceConfig);
    const config = info?.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024
      ? await readFile(sourceConfig, "utf8") : "";
    const sha256 = /^[ \t]*objectformat[ \t]*=[ \t]*sha256[ \t]*$/im.test(config);
    const reftable = includeObjects && /^[ \t]*refstorage[ \t]*=[ \t]*reftable[ \t]*$/im.test(config);
    if (reftable) {
      const from = join(original, "reftable");
      const info = await metadata(from);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Tabela de referências Git indisponível.");
      const index = join(from, "tables.list");
      const indexInfo = await metadata(index);
      if (!indexInfo?.isFile() || indexInfo.isSymbolicLink() || indexInfo.size > 1024 ** 2) {
        throw new Error("Índice de referências Git inválido.");
      }
      const names = (await readFile(index, "utf8")).trim().split(/\r?\n/);
      if (names.some(name => !/^0x[0-9a-f]+-0x[0-9a-f]+-[0-9a-f]+\.ref$/i.test(name))) {
        throw new Error("Nome inválido na tabela de referências Git.");
      }
      const to = join(sandbox, "reftable");
      await mkdir(to);
      await writeFile(join(to, "tables.list"), names.join("\n") + "\n");
      for (const name of names) await copyRegular(join(from, name), join(to, name));
    }
    const windows = process.platform === "win32";
    const safeConfig = "[core]\n\trepositoryformatversion = " + (sha256 || reftable ? "1" : "0") +
      "\n\tfsmonitor = false\n" + (windows ? "\tlongpaths = true\n\tignorecase = true\n" : "") +
      "[extensions]\n" + (sha256 ? "\tobjectFormat = sha256\n" : "") + (reftable ? "\trefStorage = reftable\n" : "");
    await writeFile(join(sandbox, "config"), safeConfig);
    const empty = join(sandbox, "empty-config");
    await writeFile(empty, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    if (parse(repo).root === repo) throw new Error("Selecione um projeto cujo repositório Git fique fora da raiz do disco.");
    const executable = await resolveExecutable("git", env, repo);
    const git = (args: string[], limit?: number, input?: string) => run(executable, [
      "--no-optional-locks", "--no-replace-objects", "--git-dir=" + sandbox, "--work-tree=" + worktree, ...args,
    ], {cwd: worktree, limit, input, env: {...env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "",
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty}});
    const prefix = relative(repo, selected).replaceAll("\\", "/");
    const addIgnore = async (folder: string, name = ".gitignore") => {
      const path = relative(repo, folder);
      if (isAbsolute(path) || path.split(sep).includes("..")) throw new Error("Pasta de regras Git inválida.");
      const source = join(folder, name);
      const info = await metadata(source);
      if (!info) return true;
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 ** 2) return false;
      const location = join(worktree, path);
      await mkdir(location, {recursive: true});
      await copyRegular(source, join(location, ".gitignore"));
      return true;
    };
    let ignoresComplete = true;
    if (!includeObjects) {
      if (!await addIgnore(repo)) ignoresComplete = false;
      for (let folder = selected; folder !== repo; folder = dirname(folder)) {
        if (!await addIgnore(folder)) ignoresComplete = false;
      }
    }
    return {git, dispose, prefix, addIgnore, ignoresComplete};
  } catch (error) {
    await dispose();
    throw error;
  }
}
