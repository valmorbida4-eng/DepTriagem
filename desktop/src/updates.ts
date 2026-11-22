import type {ReportProgress} from "./progress";
import {access, mkdir, mkdtemp, readFile, rename, rm, stat} from "node:fs/promises";
import {dirname, join} from "node:path";
import {atomicJson, dataDir, download, github, hashFile, json, run, version} from "./system";

export const repository = "valmorbida4-eng/DepTriagem";
const releases = `https://github.com/${repository}/releases`;
interface Asset {name: string; state: string; size: number; digest?: string}
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[]; body?: string; published_at?: string }
export interface Update {
  status: "available" | "current" | "asset_unavailable" | "no_release"; current: string; url: string;
  tag?: string; version?: string; notes?: string; published_at?: string; asset?: string; sha256?: string; size?: number;
  channel?: "public" | "authenticated";
}

function number(value: string) {
  const matched = /^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.exec(value);
  return matched ? Number(matched[1]) * 1e10 + Number(matched[2]) * 1e5 + Number(matched[3]) : -1;
}

export function updateAsset(release: string, platform = process.platform, arch = process.arch) {
  if (!["x64", "arm64"].includes(arch) || number(release) < 0) return undefined;
  if (platform === "win32" && arch === "x64") return `DepTriagem-Setup-${release}-win-x64.exe`;
  if (platform === "darwin") return `DepTriagem-${release}-mac-${arch}.dmg`;
  if (platform === "linux") return `DepTriagem-${release}-linux-${arch}.AppImage`;
  return undefined;
}

export function selectRelease(values: Release[], current = version): Update {
  const release = values.filter(item => !item.draft && !item.prerelease && number(item.tag_name) >= 0)
    .sort((left, right) => number(right.tag_name) - number(left.tag_name))[0];
  if (!release) return {status: "no_release", current, url: releases};
  const tag = release.tag_name, next = tag.replace(/^v/, "");
  const data = {current, tag, version: next, url: `${releases}/tag/${tag}`,
    notes: (release.body || "").slice(0, 5000), published_at: release.published_at};
  if (number(tag) <= number(current)) return {...data, status: "current"};
  const name = updateAsset(next);
  const match = release.assets?.find(item => item.name === name && item.state === "uploaded");
  if (!match || !/^sha256:[a-f0-9]{64}$/.test(match.digest || "") || !(match.size > 0 && match.size <= 350 * 1024 ** 2) ||
    !release.assets.some(item => item.name === name + ".sha256" && item.state === "uploaded")) {
    return {...data, status: "asset_unavailable"};
  }
  return {...data, status: "available", asset: name, sha256: match.digest!.slice(7), size: match.size};
}

export async function checkUpdate() {
  const endpoint = `repos/${repository}/releases?per_page=100`;
  const response = await fetch(`https://api.github.com/${endpoint}`, {signal: AbortSignal.timeout(10_000),
    headers: {"User-Agent": `DepTriagem/${version}`, Accept: "application/vnd.github+json"}}).catch(() => null);
  if (response?.ok) {
    if (Number(response.headers.get("content-length")) > 8 * 1024 ** 2) throw new Error("Índice de releases acima do limite.");
    return {...selectRelease(await response.json() as Release[]), channel: "public"} as Update;
  }
  await response?.body?.cancel();
  return {...selectRelease(await github<Release[]>(endpoint)), channel: "authenticated"} as Update;
}

export function checksum(text: string, filename: string, expected: string) {
  const values = text.split(/\r?\n/).flatMap(line => {
    const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(line.trim());
    return match && match[2] === filename ? [match[1].toLowerCase()] : [];
  });
  if (values.length !== 1 || values[0] !== expected) throw new Error("O SHA-256 publicado diverge do digest do GitHub.");
}

export async function fetchUpdate(info: Update, directory = join(dataDir, "updates"), progress?: ReportProgress) {
  if (info.status !== "available" || !info.asset || !info.sha256 || !info.size || !info.tag ||
       number(info.tag) <= number(version) || info.asset !== updateAsset(info.tag.replace(/^v/, ""))) {
    throw new Error("Não há atualização instalável disponível.");
  }
  await mkdir(directory, {recursive: true});
  const staging = await mkdtemp(join(directory, ".download-"));
  const original = join(staging, info.asset), sumPath = original + ".sha256";
  try {
    if (info.channel === "public") {
      const url = `${releases}/download/${info.tag}/${info.asset}`;
      progress?.({label: "Baixando o checksum da release"});
      await download(url + ".sha256", sumPath, 8192);
      await download(url, original, info.size, progress, "Baixando o instalador");
    } else {
      progress?.({label: "Aguardando o download pelo GitHub CLI"});
      const result = await run("gh", ["release", "download", info.tag, "--repo", repository,
        "--pattern", info.asset, "--pattern", info.asset + ".sha256", "--dir", staging], {timeout: 200_000});
      if (result.code) throw new Error("O GitHub não entregou a atualização.");
    }
    progress?.({label: "Verificando o SHA-256 do instalador"});
    if ((await stat(sumPath)).size > 8192) throw new Error("Arquivo SHA-256 acima do limite.");
    checksum(await readFile(sumPath, "utf8"), info.asset, info.sha256);
    if ((await stat(original)).size !== info.size || await hashFile(original) !== info.sha256) {
      throw new Error("O SHA-256 do instalador não confere.");
    }
    const binary = join(directory, info.asset);
    await rename(original, binary);
    await rename(sumPath, binary + ".sha256");
    progress?.({label: "Instalador verificado", completed: 1, total: 1, unit: "steps"});
    return binary;
  } finally { await rm(staging, {recursive: true, force: true}); }
}

export interface InstallResult {
  phase: "waiting" | "installing" | "complete" | "failed";
  version: string;
  reason?: "hash" | "closing" | "installer" | "version" | "reopen" | "helper";
  exit_code?: number;
}
const installRoot = join(dataDir, "updates");
const installResultPath = join(installRoot, "last-update.json");

export async function lastInstall(): Promise<InstallResult | null> {
  return json<InstallResult>(installResultPath).catch(() => null);
}

export async function launchVerifiedUpdate(binary: string, executable: string, expectedDigest: string, nextVersion: string,
  interactive = true) {
  if (process.platform !== "win32") throw new Error("A instala\u00e7\u00e3o integrada \u00e9 para Windows.");
  if (number(nextVersion) <= number(version) || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Atualiza\u00e7\u00e3o inv\u00e1lida.");
  await access(executable);
  if (await hashFile(binary) !== expectedDigest) throw new Error("O instalador foi alterado.");
  await atomicJson(installResultPath, {phase: "waiting", version: nextVersion});
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$stage='closing'",
    "$exitCode=$null",
    "function Record([string]$phase,[string]$reason) {",
    "  $value=@{phase=$phase;version=$env:DEPTRIAGEM_UPDATE_VERSION}",
    "  if ($reason) { $value.reason=$reason }",
    "  if ($null -ne $exitCode) { $value.exit_code=$exitCode }",
    "  $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:DEPTRIAGEM_UPDATE_RESULT -Encoding UTF8",
    "}",
    "try {",
    "  $p=Get-Process -Id ([int]$env:DEPTRIAGEM_UPDATE_PID) -ErrorAction SilentlyContinue",
    "  if ($p -and -not $p.WaitForExit(45000)) { throw 'closing' }",
    "  $stage='hash'",
    "  $stream=[System.IO.File]::OpenRead($env:DEPTRIAGEM_UPDATE_ASSET)",
    "  $sha=[System.Security.Cryptography.SHA256]::Create()",
    "  try { $actualHash=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') }",
    "  finally { $sha.Dispose(); $stream.Dispose() }",
    "  if ($actualHash -ne $env:DEPTRIAGEM_UPDATE_DIGEST) { throw 'hash' }",
    "  $stage='installer'",
    "  Record 'installing'",
    "  $flags=@('/currentuser')",
    "  if ($env:DEPTRIAGEM_UPDATE_INTERACTIVE -ne '1') { $flags+= '/S' }",
    "  $p=Start-Process -FilePath $env:DEPTRIAGEM_UPDATE_ASSET -ArgumentList $flags -WorkingDirectory $env:DEPTRIAGEM_UPDATE_ROOT -PassThru",
    "  $null=$p.Handle",
    "  $p.WaitForExit()",
    "  $exitCode=$p.ExitCode",
    "  if ($exitCode -ne 0) { throw 'installer' }",
    "  $stage='version'",
    "  $location=Split-Path -LiteralPath $env:DEPTRIAGEM_UPDATE_EXE",
    "  $cli=Join-Path $location 'resources/app.asar/build/electron/cli.js'",
    "  $output=[IO.Path]::GetTempFileName()",
    "  try {",
    "    $env:ELECTRON_RUN_AS_NODE='1'",
    "    $arguments=@(([char]34 + $cli + [char]34), '--version')",
    "    $check=Start-Process -FilePath $env:DEPTRIAGEM_UPDATE_EXE -ArgumentList $arguments -RedirectStandardOutput $output -NoNewWindow -PassThru",
    "    $null=$check.Handle",
    "    if (-not $check.WaitForExit(15000)) { $check.Kill(); throw 'version' }",
    "    $actual=[IO.File]::ReadAllText($output).Trim()",
    "    if ($check.ExitCode -ne 0 -or $actual -ne ('deptriagem ' + $env:DEPTRIAGEM_UPDATE_VERSION)) { throw 'version' }",
    "  } finally {",
    "    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
    "    [IO.File]::Delete($output)",
    "  }",
    "  Record 'complete'",
    "} catch { Record 'failed' $stage }",
    "if ($env:DEPTRIAGEM_UPDATE_INTERACTIVE -eq '1' -and $stage -ne 'closing' -and (Test-Path -LiteralPath $env:DEPTRIAGEM_UPDATE_EXE -PathType Leaf)) {",
    "  try { Start-Process -FilePath $env:DEPTRIAGEM_UPDATE_EXE -WorkingDirectory $env:DEPTRIAGEM_UPDATE_ROOT }",
    "  catch { Record 'failed' 'reopen' }",
    "}",
  ].join("\n");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const bootstrap = [
    "$ErrorActionPreference='Stop';",
    "$ProgressPreference='SilentlyContinue';",
    "Start-Process -FilePath $env:DEPTRIAGEM_UPDATE_POWERSHELL -WindowStyle Hidden -WorkingDirectory $env:DEPTRIAGEM_UPDATE_ROOT",
    "  -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$env:DEPTRIAGEM_UPDATE_SCRIPT",
  ].join(" ");
  try {
    const started = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(bootstrap, "utf16le").toString("base64")], {
      cwd: installRoot, timeout: 15_000, limit: 32 * 1024, env: {...process.env,
        DEPTRIAGEM_UPDATE_PID: String(process.pid), DEPTRIAGEM_UPDATE_ASSET: binary, DEPTRIAGEM_UPDATE_EXE: executable,
        DEPTRIAGEM_UPDATE_DIGEST: expectedDigest, DEPTRIAGEM_UPDATE_VERSION: nextVersion,
        DEPTRIAGEM_UPDATE_RESULT: installResultPath, DEPTRIAGEM_UPDATE_ROOT: installRoot,
        DEPTRIAGEM_UPDATE_INTERACTIVE: interactive ? "1" : "0", DEPTRIAGEM_UPDATE_POWERSHELL: powershell,
        DEPTRIAGEM_UPDATE_SCRIPT: Buffer.from(script, "utf16le").toString("base64"),
      },
    });
    if (started.code !== 0) throw new Error("O Windows n\u00e3o conseguiu iniciar o auxiliar de atualiza\u00e7\u00e3o.");
  } catch (error) {
    await atomicJson(installResultPath, {phase: "failed", version: nextVersion, reason: "helper"});
    throw error;
  }
}
