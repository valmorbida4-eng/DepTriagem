import {chmod, copyFile, link, lstat, mkdir, readdir, rm, writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {dirname, isAbsolute, join, relative, sep} from "node:path";
import {dataDir, hashFile, json, type Settings} from "./system";
import {scannerAsset} from "./catalogs";

async function publishOnce(to: string, prepare: (stage: string) => Promise<boolean>) {
  if (await lstat(to).then(() => true, () => false)) return;
  await mkdir(dirname(to), {recursive: true});
  const stage = join(dirname(to), ".migrate-" + randomUUID());
  try {
    if (!await prepare(stage)) return;
    await link(stage, to).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  } finally { await rm(stage, {force: true}); }
}

const localChild = (parent: string, path?: string) => {
  if (typeof path !== "string" || !path || !isAbsolute(path)) return false;
  const child = relative(parent, path);
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
};

async function safePath(root: string, path: string) {
  if (!localChild(root, path)) return false;
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return false;
  }
  return true;
}

async function copyOnce(from: string, to: string, limit: number, expected?: string) {
  const info = await lstat(from).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > limit) return;
  await publishOnce(to, async stage => {
    await copyFile(from, stage);
    if (expected && await hashFile(stage) !== expected) return false;
    if (expected && process.platform !== "win32") await chmod(stage, 0o755);
    return true;
  });
}

export async function migrateProfile(previous: string, target: string) {
  const marker = join(target, "profile-migration.json");
  if (await lstat(marker).then(() => true, () => false)) return;
  const oldRoot = await lstat(previous).catch(() => undefined);
  if (!oldRoot?.isDirectory() || oldRoot.isSymbolicLink()) return;
  const priorSettings = join(previous, "settings.json");
  const settingsInfo = await lstat(priorSettings).catch(() => undefined);
  const config = settingsInfo?.isFile() && !settingsInfo.isSymbolicLink() && settingsInfo.size <= 1024 ** 2
    ? await json<Settings>(priorSettings).catch(() => undefined) : undefined;
  const oldCatalog = config && localChild(previous, config.catalog_dir) ? config.catalog_dir : undefined;
  const source = oldCatalog ?? join(previous, "catalogs");
  const info = await safePath(previous, source) ? await lstat(source) : undefined;
  if (info?.isDirectory()) {
    for (const entry of await readdir(source, {withFileTypes: true})) {
      if (!entry.isFile() || !/^(?:(?:npm|PyPI|NuGet|KEV)\.json|(?:npm|PyPI|NuGet)-[a-f0-9]{64}\.zip|KEV-[a-f0-9]{64}\.json)$/.test(entry.name)) continue;
      await copyOnce(join(source, entry.name), join(target, "catalogs", entry.name), 350 * 1024 ** 2);
    }
  }
  if (scannerAsset) {
    const [name, digest] = scannerAsset;
    const binary = join(previous, "tools", name);
    if (await safePath(previous, binary)) await copyOnce(binary, join(target, "tools", name), 100 * 1024 ** 2, digest);
  }
  if (config && typeof config === "object" && !Array.isArray(config)) {
    delete config.scanner;
    if (oldCatalog) config.catalog_dir = join(target, "catalogs");
    if (localChild(previous, config.reports_dir)) {
      config.reports_dir = join(target, "reports");
      await mkdir(config.reports_dir, {recursive: true});
    }
    await publishOnce(join(target, "settings.json"), async stage => {
      await writeFile(stage, JSON.stringify(config, null, 2) + "\n", {flag: "wx", mode: 0o600});
      return true;
    });
  }
  await publishOnce(marker, async stage => {
    await writeFile(stage, '{"version":1}\n', {flag: "wx", mode: 0o600});
    return true;
  });
}

export const migratePreviousProfile = () => process.env.DEPTRIAGEM_DATA_DIR !== undefined
  ? Promise.resolve() : migrateProfile(join(dirname(dataDir), "DevTools"), dataDir);
