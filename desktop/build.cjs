const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
if (fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() !== version) {
  throw new Error("VERSION difere do package.json.");
}
for (const name of ["tsconfig.json", "tsconfig.renderer.json"]) {
  execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(__dirname, name)], {
    cwd: root, stdio: "inherit",
  });
}
const output = path.join(root, "build", "electron");
fs.copyFileSync(path.join(root, "build", "renderer", "renderer.js"), path.join(output, "renderer.js"));
for (const name of ["index.html", "style.css"]) {
  fs.copyFileSync(path.join(__dirname, "src", name), path.join(output, name));
}
fs.cpSync(path.join(root, "docs", "manuais"), path.join(output, "manuais"), {recursive: true});
fs.cpSync(path.join(__dirname, "vendor"), path.join(output, "vendor"), {recursive: true});
fs.writeFileSync(path.join(output, "version.json"), JSON.stringify({version}));
