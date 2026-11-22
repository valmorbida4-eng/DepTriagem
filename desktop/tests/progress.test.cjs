const assert = require("node:assert/strict");
const {mkdtempSync, rmSync} = require("node:fs");
const {join} = require("node:path");
const {tmpdir} = require("node:os");
const {test} = require("node:test");
const {download} = require("../../build/electron/system");

test("progresso de download usa bytes gravados e omite totais indisponiveis", async t => {
  const folder = mkdtempSync(join(tmpdir(), "deptriagem-progress-"));
  t.after(() => rmSync(folder, {recursive: true, force: true}));
  let headers = {};
  t.mock.method(globalThis, "fetch", async () => {
    const response = new Response(Buffer.from("abcde"), {headers});
    Object.defineProperty(response, "url", {value: "https://example.test/catalog"});
    return response;
  });
  for (const [index, metadata, total] of [
    [0, {"content-length": "5"}, 5], [1, {}, undefined],
    [2, {"content-length": "3", "content-encoding": "gzip"}, undefined],
  ]) {
    headers = metadata;
    const changes = [];
    const file = await download("https://example.test/catalog", join(folder, String(index)), 100, step => changes.push(step));
    assert.equal(file.bytes, 5);
    assert.equal(changes[1].completed, 0);
    assert.equal(changes.at(-1).completed, 5);
    assert.ok(changes.slice(1).every(step => step.total === total));
  }
});
