import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";

function fixture() {
  const records = new Map();
  let executable;
  const progressWindows = [];
  function ProgressWindow() {
    progressWindows.push(this);
    this.ItemProgress = class {
      setText(text) { this.text = text; }
      setProgress() {}
      setError() {}
    };
    this.changeHeadline = () => {};
    this.addDescription = () => {};
    this.show = () => { this.shown = true; };
    this.startCloseTimer = () => { this.hasCloseTimer = true; };
  }
  const scope = {
    Zotero: {
      isWin: true,
      getMainWindow: () => null,
      Prefs: { get: () => undefined },
      File: { pathToFile: p => p },
      ProgressWindow,
      logError: e => { throw e; },
    },
    IOUtils: {
      exists: async p => /pythonw?\.exe$/i.test(p),
      readJSON: async p => records.get(p),
      writeJSON: async (p, value) => records.set(p, value),
      writeUTF8: async (p, value) => records.set(p, value),
      remove: async p => records.delete(p),
    },
    PathUtils: path.win32,
    Cc: { "@mozilla.org/process/util;1": { createInstance: () => ({
      init: file => { executable = file; }, runwAsync: () => {}, isRunning: false,
    }) } },
    Ci: { nsIProcess: {} },
    Services: {},
  };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(new URL("../plugin/content/connection-client.js", import.meta.url), "utf8"), scope);
  vm.runInContext(fs.readFileSync(new URL("../plugin/content/identity.js", import.meta.url), "utf8"), scope);
  vm.runInContext(fs.readFileSync(new URL("../plugin/content/progress.js", import.meta.url), "utf8"), scope);
  vm.runInContext(fs.readFileSync(new URL("../plugin/content/translate.js", import.meta.url), "utf8"), scope);
  const api = scope.CodexPDFTranslate;
  api.settings = { pythonPath: "C:\\runtime\\Scripts\\python.exe" };
  api.workerPath = "C:\\worker.py";
  return { api, scope, records, progressWindows, identity: scope.CodexPDFIdentity, model: scope.CodexPDFProgress.model, executable: () => executable };
}

test("Windows jobs use pythonw and remain selected in the persistent progress panel", async () => {
  const f = fixture();
  const job = { directory: "C:\\job", request: { id: "job", title: "Paper" }, state: "queued" };
  f.api.jobs.set("job", job);
  await f.api.launch(job);
  assert.equal(f.executable(), "C:\\runtime\\Scripts\\pythonw.exe");
  assert.equal(f.api.attentionJobs.has("job"), true);
  assert.equal(f.progressWindows.length, 0);
});

test("Real engine progress is shown without reaching 100 before import", () => {
  const f = fixture();
  const request = { id: "job", title: "Paper" };
  let m = f.model({ request, state: "running", progress: 67.8, stage: "Translate Paragraphs", stageCurrent: 31, stageTotal: 100 });
  assert.equal(m.percent, 67);
  assert.equal(m.step, "translating");
  assert.match(m.detail, /31 \/ 100/);
  m = f.model({ request, state: "succeeded", progress: 100 });
  assert.equal(m.percent, 99);
  assert.equal(m.step, "importing");
  assert.equal(f.model({ request, state: "imported", progress: 99 }).percent, 100);
});

test("Older active jobs keep an indeterminate running bar without invented percentages", () => {
  const f = fixture();
  const m = f.model({ request: { id: "job" }, state: "running", requests: 42, batches: 7,
    message: "Codex 正在翻译第 7 批（8 个请求）" });
  assert.equal(m.percent, null);
  assert.equal(m.step, "translating");
  assert.match(m.detail, /42/);
});

test("Closing a reader cannot stop progress updates in other reader tabs", () => {
  const f = fixture();
  const dead = { get isConnected() { throw new TypeError("can't access dead object"); } };
  const live = { isConnected: true, dataset: { codexItemId: "2" } };
  f.api.readerButtons.add(dead);
  f.api.readerButtons.add(live);
  f.api.jobs.set("job", { request: { id: "job", sourceItemID: 2 }, state: "running", progress: 56 });
  f.api.refreshProgress();
  assert.equal(f.api.readerButtons.has(dead), false);
  assert.equal(live.textContent, "译 · 56%");
});

test("Queued, cancelled and failed jobs are distinct and completion elapsed time stops", () => {
  const f = fixture();
  const request = { id: "job", createdAt: 1700000000000 };
  assert.equal(f.model({ request, state: "queued", progress: 40 }).percent, null);
  assert.equal(f.model({ request, state: "cancelled" }).terminal, true);
  assert.equal(f.model({ request, state: "failed", message: "offline" }).failed, true);
  assert.equal(f.model({ request, state: "failed", message: "offline", stageCurrent: 31, stageTotal: 100 }).detail, "offline");
  const job = { request, state: "imported", startedAt: 1700000000, finishedAt: 1700000010 };
  assert.equal(f.model(job, 1700000999000).elapsed, 10);
});

test("Cancelling a queued job keeps its result visible and freezes its waiting time", async () => {
  const f = fixture();
  const job = { directory: "C:\\job", request: { id: "job", createdAt: Date.now() - 10000 }, state: "queued" };
  f.api.jobs.set("job", job);
  await f.api.cancel("job");
  assert.equal(job.state, "cancelled");
  assert.equal(f.api.attentionJobs.has("job"), true);
  assert.equal(f.records.get("C:\\job\\cancel"), "cancel");
  const status = f.records.get("C:\\job\\status.json");
  assert.ok(status.finishedAt);
  assert.equal(f.model(job, Date.now() + 60000).elapsed, f.model(job).elapsed);
});

test("A live worker heartbeat takes precedence over an exited launcher handle", async () => {
  const f = fixture();
  const job = { directory: "C:\\job", request: { title: "Paper" }, state: "running",
    startedAt: Date.now() - 100000, process: { isRunning: false } };
  f.api.jobs.set("job", job);
  f.records.set("C:\\job\\status.json", { state: "running", updatedAt: Date.now() / 1000, message: "Translating" });
  await f.api.tick();
  assert.equal(job.state, "running");
  assert.equal(f.records.get("C:\\job\\status.json").state, "running");
});

test("A stale heartbeat waits for automatic recovery and respects the retry limit", async () => {
  const f = fixture();
  const job = { directory: "C:\\job", request: { title: "Paper" }, state: "running", startedAt: Date.now() - 180000 };
  f.api.jobs.set("job", job);
  f.records.set("C:\\job\\status.json", { state: "running", updatedAt: Date.now() / 1000 - 180 });
  await f.api.tick();
  assert.equal(job.state, "waiting_retry");
  assert.equal(job.request.autoRetries, 1);
  assert.ok(job.retryAt > Date.now() / 1000);
  job.request.autoRetries = 2;
  job.state = "failed";
  assert.equal(f.api.canRecover(job), false);
});

function libraryFixture() {
  const f = fixture();
  const files = new Map([["C:\\source.pdf", "same-pdf"], ["C:\\other-name.pdf", "same-pdf"]]);
  const items = new Map();
  let generated = 0, created = 0;
  const attachment = (id, file, title = "Original", parentID = 100) => ({
    id, key: `KEY${id}`, libraryID: 1, parentID, attachmentContentType: "application/pdf", deleted: false,
    isAttachment: () => true, isRegularItem: () => false, getField: () => title, getTags: () => [],
    getFilePathAsync: async () => file, getCollections: () => [], addTag: () => {}, saveTx: async () => {},
  });
  items.set(1, attachment(1, "C:\\source.pdf"));
  items.set(2, attachment(2, "C:\\other-name.pdf"));
  items.set(100, { deleted: false, getAttachments: () => [...items.values()].filter(i => i.parentID === 100).map(i => i.id) });
  f.scope.Zotero.Items = { get: id => items.get(Number(id)) };
  f.scope.Zotero.Libraries = { get: () => ({ filesEditable: true }) };
  f.scope.Zotero.Utilities = { randomString: () => `job${++generated}`, Internal: { md5Async: async p => {
    await new Promise(resolve => setTimeout(resolve, 2));
    return files.get(p);
  } } };
  f.scope.IOUtils.exists = async p => files.has(p) || f.records.has(p) || /pythonw?\.exe$/i.test(p);
  f.scope.IOUtils.makeDirectory = async () => {};
  f.scope.IOUtils.writeJSON = async (p, value) => f.records.set(p, JSON.parse(JSON.stringify(value)));
  f.scope.Zotero.Attachments = { importFromFile: async options => {
    created++;
    const id = 1000 + created, file = `C:\\imported-${id}.pdf`;
    files.set(file, files.get(options.file));
    const item = attachment(id, file, options.title, options.parentItemID);
    items.set(id, item);
    return item;
  } };
  f.api.jobsDir = "C:\\jobs";
  f.api.stateDir = "C:\\state";
  f.api.tick = async () => {};
  return { ...f, files, items, attachment, imports: () => created };
}

test("Concurrent double clicks and identical PDFs under another name create one task", async () => {
  const f = libraryFixture();
  await Promise.all([f.api.translateItems([f.items.get(1)]), f.api.translateItems([f.items.get(1)]), f.api.translateItems([f.items.get(2)])]);
  assert.equal(f.api.jobs.size, 1);
  assert.match(f.api.lastUINotice, /没有重复启动/);
});

test("Existing readable translations prevent model work; a missing variant generates only that variant", async () => {
  const f = libraryFixture();
  await f.api.translateItems([f.items.get(1)]);
  const previous = [...f.api.jobs.values()][0];
  f.files.set("C:\\mono.pdf", "translated-mono");
  f.files.set("C:\\dual.pdf", "translated-dual");
  f.items.set(10, f.attachment(10, "C:\\mono.pdf", "[Codex 中文] Original"));
  f.items.set(11, f.attachment(11, "C:\\dual.pdf", "[Codex 对照] Original"));
  previous.state = "imported";
  previous.request.importedKinds = { mono: 10, dual: 11 };
  await f.api.translateItems([f.items.get(1)]);
  assert.equal(f.api.jobs.size, 1);
  assert.match(f.api.lastUINotice, /已有可用译文/);
  assert.deepEqual(Array.from(f.api.reusedAttachments), [10, 11]);
  f.files.delete("C:\\dual.pdf");
  await f.api.translateItems([f.items.get(1)]);
  assert.equal(f.api.jobs.size, 2);
  const missing = [...f.api.jobs.values()].at(-1);
  assert.equal(missing.request.generateMode, "dual");
  assert.equal(missing.request.existingAttachments.mono, 10);
});

test("Partial-page results do not suppress full translation, and changed files are different documents", async () => {
  const f = libraryFixture();
  const base = { libraryID: 1, sourceItemID: 1, sourceItemKey: "KEY1", sourceFingerprint: "same-pdf", pages: "1-2" };
  assert.equal(f.identity.coversSettings(base, { ...base, pages: "" }), false);
  assert.equal(f.identity.coversSettings({ ...base, pages: "" }, base), true);
  assert.equal(f.identity.pages("3, 1-2,2"), "1-3");
  await f.api.translateItems([f.items.get(1)]);
  f.files.set("C:\\other-name.pdf", "different-pdf");
  await f.api.translateItems([f.items.get(2)]);
  assert.equal(f.api.jobs.size, 2);
  f.files.set("C:\\source.pdf", "revised-original-pdf");
  await f.api.translateItems([f.items.get(1)]);
  assert.equal(f.api.jobs.size, 3);
});

test("Automatic recovery checks legacy imported paths and skips work already completed by another job", async () => {
  const f = libraryFixture();
  await f.api.translateItems([f.items.get(1)]);
  const original = [...f.api.jobs.values()][0];
  f.files.set("C:\\mono.pdf", "translated-mono");
  f.files.set("C:\\dual.pdf", "translated-dual");
  f.items.set(10, f.attachment(10, "C:\\mono.pdf", "[Codex 中文] Original"));
  f.items.set(11, f.attachment(11, "C:\\dual.pdf", "[Codex 对照] Original"));
  original.state = "imported";
  original.request.importedPaths = { "C:\\old-mono.pdf": 10, "C:\\old-dual.pdf": 11 };
  original.outputs = [{ path: "C:\\old-mono.pdf", kind: "mono" }, { path: "C:\\old-dual.pdf", kind: "dual" }];
  const retry = { request: { ...original.request, id: "retry", importedPaths: {} }, state: "failed", directory: "C:\\retry", message: "connection timed out" };
  f.api.jobs.set("retry", retry);
  await f.api.requeue(retry, true);
  assert.equal(retry.state, "imported");
  assert.equal(retry.request.importedKinds.mono, 10);
  assert.equal(retry.request.importedKinds.dual, 11);
  assert.equal(retry.request.autoRetries, undefined);
});

test("Failed jobs resume under the same ID, with medium reasoning and two parallel batches", async () => {
  const f = libraryFixture();
  await f.api.translateItems([f.items.get(1)]);
  const job = [...f.api.jobs.values()][0];
  job.state = "failed";
  job.message = "workspace routing discovery failed";
  assert.equal(f.api.canRecover(job), true);
  await f.api.translateItems([f.items.get(1)]);
  assert.equal(f.api.jobs.size, 1);
  assert.equal(job.state, "queued");
  assert.equal(job.request.config.reasoningEffort, "medium");
  assert.equal(job.request.config.parallelBatches, 2);
  job.state = "failed";
  job.message = "insufficient_quota HTTP 429";
  assert.equal(f.api.canRecover(job), false);
});

test("Concurrent import retries produce one attachment per kind, even after an interrupted journal write", async () => {
  const f = libraryFixture();
  await f.api.translateItems([f.items.get(1)]);
  const job = [...f.api.jobs.values()][0];
  f.files.set("C:\\output-mono.pdf", "translated-output");
  f.files.set("C:\\output-dual.pdf", "translated-dual");
  f.files.set("C:\\already-imported.pdf", "translated-output");
  f.items.set(10, f.attachment(10, "C:\\already-imported.pdf", "[Codex 中文] Original"));
  job.outputs = [{ path: "C:\\output-mono.pdf", kind: "mono" }, { path: "C:\\output-dual.pdf", kind: "dual" }];
  job.state = "succeeded";
  await Promise.all([f.api.importOutputs(job), f.api.importOutputs(job)]);
  assert.equal(f.imports(), 1);
  assert.equal(job.request.importedKinds.mono, 10);
  assert.ok(job.request.importedKinds.dual);
  assert.equal(job.state, "imported");
});

test("Recovery countdown is visible and cancelling it prevents automatic relaunch", async () => {
  const f = libraryFixture();
  await f.api.translateItems([f.items.get(1)]);
  const job = [...f.api.jobs.values()][0];
  await f.api.requeue(job, true);
  assert.equal(f.model(job).step, "retrying");
  assert.match(f.model(job).detail, /秒后重试/);
  await f.api.cancel(job.request.id);
  assert.equal(job.state, "cancelled");
  assert.equal(f.api.canRecover(job), false);
});

test("An existing variant removed during generation cannot be reported as a complete pair", async () => {
  const f = libraryFixture();
  await f.api.translateItems([f.items.get(1)]);
  const job = [...f.api.jobs.values()][0];
  f.items.set(10, f.attachment(10, "C:\\missing-mono.pdf", "[Codex 中文] Original"));
  job.request.existingAttachments = { mono: 10 };
  f.files.set("C:\\output-dual.pdf", "translated-dual");
  job.outputs = [{ path: "C:\\output-dual.pdf", kind: "dual" }];
  job.state = "succeeded";
  await f.api.importOutputs(job);
  assert.equal(f.imports(), 1);
  assert.equal(job.state, "failed");
  assert.equal(f.api.canRecover(job), false);
  assert.match(job.message, /只补缺少/);
});

test("New jobs snapshot the selected API without plaintext keys and recovery keeps the original provider", async () => {
  const f = libraryFixture();
  await f.api.translateItems([f.items.get(1)]);
  const old = [...f.api.jobs.values()][0];
  f.api.connectionSettings = { selected: "api-test", apis: [{ id: "api-test", name: "Test API", baseUrl: "https://example.org/v1", model: "unit-model", credentialRef: "reference-only" }] };
  const config = f.api.config();
  assert.equal(config.provider, "api");
  assert.equal(config.model, "unit-model");
  assert.equal(config.credentialRef, "reference-only");
  assert.equal(config.apiKey, undefined);
  assert.equal(config.parallelBatches, 2);
  old.state = "failed"; old.message = "connection timed out";
  await f.api.requeue(old, true);
  assert.equal(old.request.config.provider, "codex");
  assert.equal(old.request.config.baseUrl, undefined);
});

test("Connection requests suppress request-body logging when API keys are submitted", async () => {
  const f = fixture();
  let captured;
  f.scope.Zotero.HTTP = { request: async (method, url, options) => { captured = options; return { status: 200, response: { ok: true } }; } };
  const client = f.scope.CodexPDFConnections.create(f.api);
  client.url = "http://127.0.0.1:12345";
  client.token = "test-control-token";
  await client.raw("POST", "/api/save", { apiKey: "unit-only-fake-secret" });
  assert.equal(captured.logBodyLength, 0);
  assert.equal(captured.debug, false);
});
