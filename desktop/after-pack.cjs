const fs = require("node:fs");
const path = require("node:path");

module.exports = context => {
  if (context.electronPlatformName !== "win32") return;
  const files = [], folders = [];
  function visit(current) {
    for (const entry of fs.readdirSync(path.join(context.appOutDir, current), {withFileTypes: true})) {
      if (!/^[\w. -]+$/.test(entry.name)) throw new Error("Nome não suportado no manifesto de desinstalação.");
      const relative = current ? current + "\\" + entry.name : entry.name;
      if (entry.isDirectory()) {
        visit(relative);
        folders.push(relative);
      } else if (entry.isFile()) files.push(relative);
    }
  }
  visit("");
  const target = path.resolve(__dirname, "..", "build", "electron-install-files.nsh");
  fs.writeFileSync(target, [
    ...files.map(name => `Delete "$INSTDIR\\${name}"`),
    ...folders.map(name => `RMDir "$INSTDIR\\${name}"`),
    "",
  ].join("\r\n"));
};
