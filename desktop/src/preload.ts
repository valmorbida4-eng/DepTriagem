import {contextBridge, ipcRenderer} from "electron";

const channels = new Set([
  "app:state", "app:settings", "app:pick", "app:read-report", "app:save-report", "app:export-analysis",
  "monitor:status", "monitor:save", "monitor:run", "monitor:open-report",
  "manual:open", "diagnostics:copy",
  "model:credentials", "model:credential", "model:test", "model:list",
  "launcher:reviewer-models",
  "mcp:destination", "mcp:preview", "mcp:copy", "mcp:test", "mcp:open-location", "mcp:connection",
  "github:account", "github:repositories", "github:login", "project:analyze", "project:review",
  "catalog:status", "catalog:sync", "catalog:scanner", "catalog:install", "launcher:open",
  "launcher:control", "launcher:watch", "launcher:token-status", "launcher:remember-token", "launcher:forget-token", "launcher:health",
  "triage:run", "triage:test", "triage:models", "update:check", "update:download",
  "update:install", "update:last-install", "update:open-release",
]);
contextBridge.exposeInMainWorld("deptriagem", {
  invoke(channel: string, input?: object) {
    if (!channels.has(channel)) return Promise.reject(new Error("Operação inválida."));
    return ipcRenderer.invoke(channel, input);
  },
  onMonitor(listener: (event: string, value: unknown) => void) {
    for (const name of ["changed", "progress", "error", "open"]) {
      ipcRenderer.on("monitor:" + name, (_event, value: unknown) => listener(name, value));
    }
  },
  onProgress(listener: (id: string, value: unknown) => void) {
    ipcRenderer.on("operation:progress", (_event, id: string, value: unknown) => listener(id, value));
  },
  onTheme(listener: (dark: boolean) => void) {
    ipcRenderer.on("theme:changed", (_event, dark: boolean) => listener(dark));
  },
});
