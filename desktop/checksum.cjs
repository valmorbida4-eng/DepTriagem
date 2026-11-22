const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const version = require("../package.json").version.replaceAll(".", "\\.");
const root = path.join(__dirname, "..", "dist");
const expected = process.platform === "win32"
  ? new RegExp(`^DepTriagem-Setup-${version}-win-(x64|arm64)\\.exe$`)
  : process.platform === "darwin"
    ? new RegExp(`^DepTriagem-${version}-mac-(x64|arm64)\\.dmg$`)
    : new RegExp(`^DepTriagem-${version}-linux-(x64|x86_64|amd64|arm64|aarch64)\\.(AppImage|deb|rpm)$`);
const files = fs.readdirSync(root).filter(name => expected.test(name)).sort((a, b) => Number(/-linux-(x64|arm64)\./.test(a)) - Number(/-linux-(x64|arm64)\./.test(b)));
const checksummed = new Set();
if (!files.length) throw new Error("Nenhum instalador da versao atual encontrado.");
for (const file of files) {
  const name = file.replace(/-linux-(?:x86_64|amd64)\./, "-linux-x64.").replace(/-linux-aarch64\./, "-linux-arm64.");
  if (checksummed.has(name)) continue;
  const target = path.join(root, name);
  if (name !== file) fs.renameSync(path.join(root, file), target);
  checksummed.add(name);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  fs.writeFileSync(target + ".sha256", `${hash}  ${name}\n`);
}
