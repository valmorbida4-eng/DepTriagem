const assert = require("node:assert/strict");
const {test} = require("node:test");
const {mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const folder = mkdtempSync(join(tmpdir(), "deptriagem-monitor-test-"));
process.env.DEPTRIAGEM_DATA_DIR = folder;
const projects = require("../../build/electron/projects");
const catalogs = require("../../build/electron/catalogs");
const monitor = require("../../build/electron/monitor");
test.after(() => rmSync(folder, {recursive: true, force: true}));

test("preserva o dia de inicio quando o mes anterior e mais curto", () => {
  const iso = (month, day) => new Date(2025, month - 1, day, 9).toISOString();
  assert.equal(monitor.nextRun(iso(1,31), "monthly", iso(1,31)).toISOString(), iso(2,28));
  assert.equal(monitor.nextRun(iso(1,31), "monthly", iso(2,28)).toISOString(), iso(3,31));
  assert.equal(monitor.nextRun(iso(1,1), "daily", iso(1,10)).toISOString(), iso(1,11));
  assert.equal(monitor.nextRun(iso(1,1), "weekly", iso(1,10)).toISOString(), iso(1,15));
  assert.equal(monitor.nextRun(iso(1,1), "hourly", iso(1,1)).getTime(), Date.parse(iso(1,1)) + 3600000);
});

test("relatorios, falha isolada, ausencia de alertas duplicados e pausa", async t => {
  const finding = {name:"sample", version:"1.0.0", ecosystem:"npm", source:"package-lock.json",
    ids:["TEST-1"], kev:[], priority:"manual_review"};
  t.mock.method(projects, "account", async () => "example");
  t.mock.method(projects, "repositories", async () => ({login:"example", repos:["example/first","example/second"]}));
  const scans = [];
  t.mock.method(projects, "analyze", async input => {
    assert.equal(input.expectedAccount, "example");
    scans.push(input.target);
    if (input.target.endsWith("/second")) throw new Error("unavailable");
    return {coverage:"inventory_scanned", findings:[finding]};
  });
  await monitor.saveMonitor({enabled:true, scope:"all", start:"2025-01-01T12:00:00Z", period:"hourly"});
  const first = await monitor.runMonitor(false);
  assert.deepEqual(scans, ["example/first","example/second"]);
  assert.equal(first.repos[0].added, 1);
  assert.equal(JSON.parse(readFileSync(first.repos[0].report,"utf8")).monitoring.new_findings.length, 1);
  assert.ok(first.repos[1].error);
  assert.equal(await monitor.runMonitor(false), null);
  const second = await monitor.runMonitor(true);
  assert.equal(second.repos[0].added, 0);
  assert.ok((await monitor.monitorStatus()).next);
  await monitor.saveMonitor({enabled:false});
  assert.equal((await monitor.monitorStatus()).next, null);
  assert.equal(await monitor.runMonitor(false), null);
});

test("uma cobertura parcial nao apaga achados conhecidos", () => {
  const finding = {name:"sample", version:"1.0.0", ecosystem:"npm", source:"package-lock.json",
    ids:["TEST-1"], kev:[], priority:"manual_review"};
  const initial = monitor.compareFindings([finding], [], false);
  const partial = monitor.compareFindings([], initial.baseline, true);
  assert.equal(monitor.compareFindings([finding], partial.baseline, false).added.length, 0);
  assert.equal(monitor.compareFindings([{...finding, priority:"maximum"}], partial.baseline, false).added.length, 1);
});

test("o monitor aplica o intervalo salvo e mantém 24 horas em agendamentos anteriores", async t => {
  const hour = 3_600_000;
  t.mock.timers.enable({apis: ["Date"], now: new Date("2026-11-22T12:00:00Z")});
  t.mock.method(projects, "account", async () => "example");
  t.mock.method(projects, "repositories", async () => ({login: "example", repos: []}));
  t.mock.method(catalogs, "catalogStatus", async () => ({
    npm: {downloaded_at: new Date(Date.now() - 8 * hour).toISOString()},
    PyPI: {downloaded_at: new Date(Date.now() - 2 * hour).toISOString()},
  }));
  const updated = [];
  t.mock.method(catalogs, "syncCatalogs", async (_dir, source) => {
    updated.push(source);
    return {[source]: {status: "updated"}};
  });
  const legacy = {id: "old", enabled: true, login: "example", scope: "all", repos: [],
    start: "2025-01-01T12:00:00Z", period: "hourly", refresh: true};
  mkdirSync(join(folder, "monitor"), {recursive: true});
  writeFileSync(join(folder, "monitor", "schedule.json"), JSON.stringify(legacy));
  assert.equal((await monitor.monitorStatus()).config.refreshHours, 24);
  await assert.rejects(monitor.saveMonitor({...legacy, refreshHours: 1.5}), /horas inteiras/);
  await monitor.saveMonitor({...legacy, refreshHours: 6});
  assert.equal((await monitor.monitorStatus()).config.refreshHours, 6);
  await monitor.runMonitor(true);
  assert.deepEqual(updated.splice(0), ["npm", "NuGet", "KEV"]);
  t.mock.timers.tick(5 * hour);
  await monitor.runMonitor(true);
  assert.deepEqual(updated, []);
  t.mock.timers.tick(hour);
  await monitor.runMonitor(true);
  assert.deepEqual(updated.splice(0), ["npm", "NuGet", "KEV"]);
  await monitor.saveMonitor({...legacy, refresh: false});
  assert.equal((await monitor.monitorStatus()).config.refreshHours, 6);
  t.mock.timers.tick(6 * hour);
  await monitor.runMonitor(true);
  assert.deepEqual(updated, []);
});
