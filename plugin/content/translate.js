/* global Zotero, Services, Cc, Ci, IOUtils, PathUtils, rootURI, pluginID, version */
var CodexPDFTranslate = {
  pref: "extensions.zotero.codexPDFTranslate.",
  jobs: new Map(),
  menus: [],
  imports: new Set(),
  timer: null,
  observerID: null,
  workerPath: "",
  settings: {},
  progressViews: new Map(),
  metadataViews: new Map(),
  attentionJobs: new Set(),
  readerButtons: new Set(),
  uiPreparing: false,
  lastUIError: "",
  lastUINotice: "",
  reusedAttachments: [],
  submissionTail: Promise.resolve(),
  importTail: Promise.resolve(),

  getPref(name, fallback) {
    const value = Zotero.Prefs.get(this.pref + name, true);
    return value === undefined ? fallback : value;
  },

  setPref(name, value) {
    Zotero.Prefs.set(this.pref + name, value, true);
  },

  async loadRuntimeSettings() {
    try {
      // Windows PowerShell 5.1 writes UTF-8 JSON with a BOM by default.
      const text = await IOUtils.readUTF8(PathUtils.join(this.stateDir, "config.json"));
      const value = JSON.parse(text.replace(/^\uFEFF/, ""));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置格式无效");
      for (const name of ["pythonPath", "codexPath"]) {
        if (typeof value[name] === "string") this.settings[name] = value[name].trim();
      }
      this.runtimeConfigError = "";
    } catch (error) {
      if (error.name !== "NotFoundError") {
        this.runtimeConfigError = "运行环境配置无法读取，请重新运行 setup.ps1 或在设置中填写路径。";
        Zotero.debug("Codex runtime configuration: " + error);
      }
    }
  },

  async resolvePython() {
    // Re-read after setup: a stale or empty preference must not hide a valid install.
    await this.loadRuntimeSettings();
    const configured = this.getPref("pythonPath", "");
    const standard = Zotero.isWin ? PathUtils.join(this.stateDir, "runtime", "Scripts", "python.exe")
      : PathUtils.join(this.stateDir, "runtime", "bin", "python");
    const candidates = [...new Set([configured, this.settings.pythonPath, standard].filter(p => typeof p === "string" && p.trim()).map(p => p.trim()))];
    for (const path of candidates) {
      if (!await IOUtils.exists(path)) continue;
      const executable = Zotero.isWin ? path.replace(/python\.exe$/i, "pythonw.exe") : path;
      if (!await IOUtils.exists(executable)) continue;
      if (configured !== path) this.setPref("pythonPath", path);
      return executable;
    }
    throw new Error(this.runtimeConfigError || "未找到可用的 Python 环境（Windows 需同时有 python.exe 和 pythonw.exe）。请运行 setup.ps1，或在设置中填写路径。");
  },

  async startup() {
    const restore = this.getPref("restoreAutoDisableScopes", "");
    if (restore) {
      const previous = JSON.parse(restore);
      if (previous.hadUserValue) Services.prefs.setIntPref("extensions.autoDisableScopes", previous.value);
      else Services.prefs.clearUserPref("extensions.autoDisableScopes");
      Services.prefs.clearUserPref(this.pref + "restoreAutoDisableScopes");
    }
    this.stateDir = this.getPref("stateDir", "");
    if (!this.stateDir) {
      const local = Services.dirsvc.get("LocalAppData", Ci.nsIFile).path;
      this.stateDir = PathUtils.join(local, "ZoteroCodexTranslate");
    }
    this.jobsDir = PathUtils.join(this.stateDir, "jobs");
    await IOUtils.makeDirectory(this.jobsDir, { ignoreExisting: true });
    await this.loadRuntimeSettings();
    const backend = PathUtils.join(this.stateDir, "backend", version);
    await IOUtils.makeDirectory(backend, { ignoreExisting: true });
    this.workerPath = PathUtils.join(backend, "worker.py");
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    for (const name of ["worker.py", "engine.py", "providers.py", "connections.py", "text.py"]) {
      const source = await new Promise((resolve, reject) => {
        NetUtil.asyncFetch({ uri: rootURI + "backend/" + name, loadUsingSystemPrincipal: true }, (input, status) => {
          if (status !== 0) return reject(new Error("无法读取插件内的 Python 后台：" + status));
          try { resolve(NetUtil.readInputStreamToString(input, input.available(), { charset: "UTF-8" })); }
          catch (error) { reject(error); }
        });
      });
      await IOUtils.writeUTF8(PathUtils.join(backend, name), source);
    }
    this.connectionPath = PathUtils.join(backend, "connections.py");
    this.connections = CodexPDFConnections.create(this);
    try { this.connectionSettings = await IOUtils.readJSON(PathUtils.join(this.stateDir, "connections.json")); }
    catch (error) {
      this.connectionSettings = { version: 1, selected: "codex", codexMode: "shared", codexModel: this.getPref("model", ""), apis: [] };
      if (error.name === "NotFoundError") await IOUtils.writeJSON(PathUtils.join(this.stateDir, "connections.json"), this.connectionSettings);
      else Zotero.logError(error);
    }
    this.paneID = await Zotero.PreferencePanes.register({
      pluginID, src: "chrome://codex-pdf-translate/content/preferences.xhtml", label: "Codex PDF 翻译",
      scripts: ["chrome://codex-pdf-translate/content/preferences.js"],
    });
    this.registerMenus();
    this.toolbarHandler = ({ reader, doc, append }) => {
      const button = doc.createElement("button");
      button.className = "codex-pdf-translate-button";
      button.textContent = "译";
      button.dataset.codexItemId = String(reader.itemID);
      button.title = "使用当前选定的模型翻译 PDF，并保留版式";
      button.style.cssText = "padding:2px 9px;margin:0 5px;cursor:pointer;border:1px solid #9aa7b8;border-radius:5px;background:transparent;color:inherit;font-weight:600";
      button.addEventListener("click", () => this.translateItems([Zotero.Items.get(reader.itemID)]));
      append(button);
      this.readerButtons.add(button);
    };
    Zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, pluginID);
    this.observerID = Zotero.Notifier.registerObserver({
      notify: async (event, type, ids) => {
        if (event !== "add" || type !== "item" || !this.getPref("autoTranslate", false)) return;
        // Attachment import notifies before the PDF copy and title update are complete.
        await Zotero.Promise.delay(2500);
        for (const id of ids) {
          const item = Zotero.Items.get(id);
          if (this.isPDF(item) && !this.isTranslation(item) && !this.imports.has(id)) {
            await this.translateItems([item], true);
          }
        }
      },
    }, ["item"], "codex-pdf-translate");
    await this.recoverJobs();
    this.timer = setInterval(() => this.tick().catch(e => Zotero.logError(e)), 1500);
    for (const window of Zotero.getMainWindows()) this.onWindow(window);
    await this.writeTestReport();
    await this.tick();
  },

  registerMenus() {
    const translate = {
      menuType: "menuitem", l10nID: "codex-pdf-translate-selected",
      onShowing: (event, context) => context.setEnabled(context.items?.some(i => this.isPDF(i) || i.isRegularItem())),
      onCommand: (event, context) => this.translateItems(context.items || this.selectedItems()),
    };
    const workspace = {
      ...translate, l10nID: "codex-pdf-workbench-selected",
      onCommand: (event, context) => this.openWorkbench(context.items || this.selectedItems()),
    };
    this.menus.push(Zotero.MenuManager.registerMenu({
      menuID: "codex-pdf-translate-item", pluginID, target: "main/library/item", menus: [workspace, translate],
    }));
    this.menus.push(Zotero.MenuManager.registerMenu({
      menuID: "codex-pdf-translate-tools", pluginID, target: "main/menubar/tools", menus: [{
        menuType: "submenu", l10nID: "codex-pdf-translate-menu", menus: [
          { menuType: "menuitem", l10nID: "codex-pdf-workbench", onCommand: () => this.openWorkbench() },
          { menuType: "menuitem", l10nID: "codex-pdf-translate-progress", onCommand: () => this.openProgress() },
          { menuType: "menuitem", l10nID: "codex-pdf-translate-selected", onCommand: () => this.translateItems(this.selectedItems()) },
          { menuType: "menuitem", l10nID: "codex-pdf-translate-settings", onCommand: () => this.openSettings() },
          { menuType: "menuitem", l10nID: "codex-pdf-translate-doctor", onCommand: () => this.checkEnvironment() },
          { menuType: "menuitem", l10nID: "codex-pdf-translate-cancel", onCommand: () => this.cancelAll() },
        ],
      }],
    }));
  },

  openWorkbench(items = null) {
    if (!this.workbench || this.workbench.closed) {
      const owner = Zotero.getMainWindow();
      if (!owner) return;
      this.workbench = owner.openDialog("chrome://codex-pdf-translate/content/workbench.xhtml",
        "codex-pdf-workbench", "chrome,centerscreen,resizable,nonmodal,width=1060,height=740", this);
    } else this.workbench.focus();
    if (items) return this.translateItems(items, true, true).catch(() => {
      // The submission has recorded its error for the workbench.
    });
  },

  onWindow(window) {
    window.MozXULElement?.insertFTLIfNeeded("codex-pdf-translate.ftl");
    if (!this.metadataViews.has(window)) this.metadataViews.set(window, CodexPDFMetadata.attach(window, this));
    if (!this.progressViews.has(window)) {
      const view = CodexPDFProgress.attach(window, this);
      if (view) this.progressViews.set(window, view);
    }
    this.refreshProgress();
  },

  removeWindow(window) {
    this.metadataViews.get(window)?.destroy();
    this.metadataViews.delete(window);
    this.progressViews.get(window)?.destroy();
    this.progressViews.delete(window);
  },

  openProgress() {
    const window = Zotero.getMainWindow();
    if (window) this.onWindow(window);
    if (![...this.jobs.values()].some(job => !this.isTerminal(job.state)) && !this.uiPreparing) {
      const last = [...this.jobs.values()].at(-1);
      if (last) this.attentionJobs.add(last.request.id);
      else if (!this.lastUINotice) this.lastUIError = "暂无翻译任务。请选择 PDF，点击阅读器中的“译”开始。";
    }
    for (const view of this.progressViews.values()) view.expand();
  },

  refreshProgress() {
    for (const [window, view] of this.progressViews) {
      if (window.closed) this.removeWindow(window);
      else view.render();
    }
    for (const button of this.readerButtons) {
      try {
        if (!button.isConnected) { this.readerButtons.delete(button); continue; }
        const job = [...this.jobs.values()].find(j => j.request.sourceItemID === Number(button.dataset.codexItemId) &&
          (!this.isTerminal(j.state) || (j.state === "succeeded" && !j.request.doctor)));
        const m = job && CodexPDFProgress.model(job);
        button.textContent = m ? (m.percent === null ? `译 · ${m.state === "queued" ? "排队中" : "运行中"}` : `译 · ${m.percent}%`) : "译";
        button.title = m ? `${m.label}，点击查看进度` : "使用当前选定的模型翻译 PDF，并保留版式";
      } catch (error) {
        // Reader tabs have their own realm; closing one can invalidate its DOM wrappers.
        this.readerButtons.delete(button);
      }
    }
  },

  progressModel(job) { return CodexPDFProgress.model(job); },

  selectedItems() {
    const window = Zotero.getMainWindow();
    const reader = window?.Zotero_Tabs?.selectedType === "reader"
      ? Zotero.Reader.getByTabID(window.Zotero_Tabs.selectedID) : null;
    return reader ? [Zotero.Items.get(reader.itemID)] : (window?.ZoteroPane?.getSelectedItems() || []);
  },

  isPDF(item) {
    return !!item?.isAttachment() && item.attachmentContentType === "application/pdf";
  },

  isTranslation(item) {
    return item.getTags().some(t => t.tag === "codex-pdf-translation") ||
      /^(?:\[Codex 中文\]|\[Codex 对照\])/.test(item.getField("title"));
  },

  notify(title, message, error = false) {
    const window = new Zotero.ProgressWindow({ closeOnClick: true });
    window.changeHeadline(title);
    window.addDescription(String(message).slice(0, 500));
    window.show();
    window.startCloseTimer(error ? 16000 : 7000);
  },

  showJobProgress(job) {
    this.attentionJobs.add(job.request.id);
    this.openProgress();
  },

  updateJobProgress(job) {
    if (this.isTerminal(job.state) && !job.notified) this.attentionJobs.add(job.request.id);
    this.refreshProgress();
  },

  config() {
    const connections = this.connectionSettings || { selected: "codex", apis: [] };
    const config = {
      provider: "codex", providerName: "Codex",
      codexPath: this.getPref("codexPath", this.settings.codexPath || ""),
      model: typeof connections.codexModel === "string" ? connections.codexModel : this.getPref("model", ""),
      requestTimeout: 300,
      batchSize: 16, batchChars: 24000, batchWindow: 0.8,
      parallelBatches: 2, batchRetries: 2, reasoningEffort: connections.codexReasoningEffort || "medium",
    };
    if (connections.selected && connections.selected !== "codex") {
      const profile = connections.apis.find(p => p.id === connections.selected);
      if (!profile) throw new Error("请先在设置中保存 API 连接，或选择 Codex。");
      Object.assign(config, { provider: "api", providerName: profile.name, baseUrl: profile.baseUrl,
        model: profile.model, credentialRef: profile.credentialRef || "", stateDir: this.stateDir,
        apiReasoningEffort: profile.reasoningEffort || "provider-default", maxOutputTokens: profile.maxOutputTokens || 8192,
        batchSize: 8, batchChars: 12000 });
    } else if (connections.codexMode === "isolated") config.codexHome = PathUtils.join(this.stateDir, "codex-auth");
    return config;
  },

  translateItems(items, silent = false, reportEmptySelection = false) {
    // Serialize before the first await: two clicks must never pass the same lookup concurrently.
    if (!silent) { this.uiPreparing = true; this.openProgress(); }
    const task = this.submissionTail.catch(e => Zotero.logError(e)).then(() => this._translateItems(items, silent, reportEmptySelection));
    this.submissionTail = task;
    return task;
  },

  translateFiles(paths, pages, outputMode) {
    const task = this.submissionTail.catch(e => Zotero.logError(e))
      .then(async () => {
        const results = [], errors = [];
        const options = this.requestOptions(pages, outputMode);
        for (const inputPath of new Set(paths)) {
          const title = PathUtils.filename(inputPath);
          try {
            if (!/\.pdf$/i.test(title) || !await IOUtils.exists(inputPath) || (await IOUtils.stat(inputPath)).type !== "regular") {
              throw new Error("请选择可读取的本机 PDF 文件。");
            }
            const request = { ...options, localFile: true, libraryID: null, title, inputPath,
              stateDir: this.stateDir, createdAt: Date.now() };
            await this.fingerprint(request);
            if (!request.sourceFingerprint) throw new Error("无法读取 PDF 文件。");
            const matches = await this.matchingJobs(request);
            const wanted = CodexPDFIdentity.kinds(request.outputMode);
            let reused = null;
            for (const previous of matches) {
              const kinds = CodexPDFIdentity.kinds(previous.request.outputMode);
              if (!wanted.every(kind => kinds.includes(kind))) continue;
              if (!this.isTerminal(previous.state)) { reused = previous; break; }
              if (previous.state === "succeeded") {
                const available = [];
                for (const output of previous.outputs || []) {
                  if (await IOUtils.exists(output.path)) available.push(output.kind);
                }
                if (wanted.every(kind => available.includes(kind))) { reused = previous; break; }
              }
            }
            results.push({ title, inputPath, job: reused || await this.enqueue(request), reused: !!reused });
          } catch (error) {
            errors.push(title + "：" + error.message);
          }
        }
        await this.tick();
        return { results, errors };
      });
    this.submissionTail = task;
    return task;
  },

  requestOptions(pages = this.getPref("pages", ""), outputMode = this.getPref("outputMode", "both")) {
    if (!["both", "mono", "dual"].includes(outputMode)) throw new Error("请选择输出格式。");
    return { langIn: this.getPref("langIn", "en"), langOut: this.getPref("langOut", "zh"),
      outputMode, pages: CodexPDFIdentity.pages(pages), config: this.config() };
  },

  async enqueue(request) {
    const id = Zotero.Utilities.randomString(12);
    request.id = id;
    const directory = PathUtils.join(this.jobsDir, id);
    await IOUtils.makeDirectory(directory);
    const job = { request, directory, state: "queued", message: "等待翻译", process: null };
    await IOUtils.writeJSON(PathUtils.join(directory, "request.json"), request);
    await IOUtils.writeJSON(PathUtils.join(directory, "status.json"), { state: "queued", message: "等待翻译" });
    this.jobs.set(id, job);
    return job;
  },

  async fingerprint(request, directory) {
    if (request.sourceFingerprint) return request.sourceFingerprint;
    const snapshot = directory && PathUtils.join(directory, "source.pdf");
    const path = snapshot && await IOUtils.exists(snapshot) ? snapshot : request.inputPath;
    if (!path || !await IOUtils.exists(path)) return "";
    const fingerprint = await Zotero.Utilities.Internal.md5Async(path);
    if (fingerprint) {
      request.sourceFingerprint = fingerprint;
      if (directory) await IOUtils.writeJSON(PathUtils.join(directory, "request.json"), request);
    }
    return fingerprint || "";
  },

  async matchingJobs(request) {
    const matches = [];
    for (const job of [...this.jobs.values()].reverse()) {
      if (job.request.doctor || job.request.libraryID !== request.libraryID) continue;
      await this.fingerprint(job.request, job.directory);
      if (CodexPDFIdentity.coversSettings(job.request, request)) matches.push(job);
    }
    return matches;
  },

  async usableAttachment(id, libraryID) {
    if (!id) return null;
    const item = Zotero.Items.get(Number(id));
    if (!item || item.deleted || item.libraryID !== libraryID || !this.isPDF(item)) return null;
    if (item.parentID && Zotero.Items.get(item.parentID)?.deleted) return null;
    const path = await item.getFilePathAsync();
    return path && await IOUtils.exists(path) ? item : null;
  },

  async translationsFrom(job, libraryID) {
    const result = {};
    const request = job.request;
    const direct = { ...request.existingAttachments, ...request.importedKinds };
    for (const output of job.outputs || []) {
      const id = request.importedPaths?.[output.path];
      if (id) direct[output.kind] = id;
    }
    for (const id of Object.values(request.importedPaths || {})) {
      const item = await this.usableAttachment(id, libraryID);
      if (!item) continue;
      const title = item.getField("title");
      if (title.startsWith("[Codex 中文]")) direct.mono ||= id;
      if (title.startsWith("[Codex 对照]")) direct.dual ||= id;
    }
    for (const [kind, id] of Object.entries(direct)) {
      if (await this.usableAttachment(id, libraryID)) result[kind] = Number(id);
    }
    return result;
  },

  async _translateItems(items, silent = false, reportEmptySelection = false) {
    this.uiPreparing = true;
    this.lastUIError = "";
    this.lastUINotice = "";
    this.reusedAttachments = [];
    if (!silent) this.openProgress();
    try {
      const ids = new Set();
      for (const item of items.filter(Boolean)) {
        if (this.isPDF(item) && !this.isTranslation(item)) ids.add(item.id);
        else if (item.isRegularItem()) {
          for (const id of item.getAttachments()) {
            const attachment = Zotero.Items.get(id);
            if (this.isPDF(attachment) && !this.isTranslation(attachment)) ids.add(id);
          }
        }
      }
      if (!ids.size && (!silent || reportEmptySelection)) throw new Error("请选择 PDF 附件，或包含 PDF 的文献条目。");
      for (const id of ids) {
        const item = Zotero.Items.get(id);
        const inputPath = await item.getFilePathAsync();
        if (!inputPath || !await IOUtils.exists(inputPath)) throw new Error("PDF 尚未下载到本机，请先打开或下载附件。");
        if (!Zotero.Libraries.get(item.libraryID).filesEditable) throw new Error("当前文献库无权添加译文附件。");
        const request = {
          inputPath, sourceItemID: id, sourceItemKey: item.key, libraryID: item.libraryID,
          parentItemID: item.parentID || null, collections: item.parentID ? [] : item.getCollections(),
          title: item.getField("title"), stateDir: this.stateDir, createdAt: Date.now(),
          ...this.requestOptions(), importedPaths: {},
        };
        await this.fingerprint(request);
        const matches = await this.matchingJobs(request);
        const existing = matches.find(j => ["queued", "starting", "running", "waiting_retry", "succeeded"].includes(j.state));
        if (existing) {
          this.lastUINotice = "该 PDF 已有任务，已定位原任务，没有重复启动。";
          if (!silent) this.showJobProgress(existing);
          continue;
        }
        const available = {};
        for (const previous of matches) Object.assign(available, await this.translationsFrom(previous, request.libraryID));
        const missing = CodexPDFIdentity.kinds(request.outputMode).filter(kind => !available[kind]);
        if (!missing.length) {
          this.lastUINotice = "已有可用译文，已跳过重复翻译。";
          this.reusedAttachments = CodexPDFIdentity.kinds(request.outputMode).map(kind => available[kind]);
          if (!silent) this.openProgress();
          continue;
        }
        request.existingAttachments = available;
        request.generateMode = missing.length === 2 ? "both" : missing[0];
        const retry = matches.find(j => ["failed", "cancelled"].includes(j.state) &&
          CodexPDFIdentity.pages(j.request.pages || "") === request.pages);
        if (retry) {
          retry.request = { ...request, id: retry.request.id, createdAt: retry.request.createdAt, autoRetries: 0 };
          await this.requeue(retry, false);
          if (!silent) this.showJobProgress(retry);
          continue;
        }
        const job = await this.enqueue(request);
        if (!silent) this.showJobProgress(job);
      }
      await this.tick();
    } catch (error) {
      Zotero.logError(error);
      this.lastUIError = error.message;
      if (!reportEmptySelection) this.notify("无法开始翻译", error.message, true);
      if (reportEmptySelection) throw error;
    } finally { this.uiPreparing = false; this.refreshProgress(); }
  },

  isTerminal(state) {
    return ["succeeded", "failed", "cancelled", "imported"].includes(state);
  },

  canRecover(job) {
    return job.state === "failed" && !job.request.doctor && !job.cancelling && (job.request.autoRetries || 0) < 2 &&
      (job.retryable === true || job.retryable === undefined && CodexPDFIdentity.transient(job.message));
  },

  async reuseCompleted(job) {
    if (job.request.doctor || job.request.localFile) return false;
    await this.fingerprint(job.request, job.directory);
    const available = {};
    for (const previous of await this.matchingJobs(job.request)) {
      Object.assign(available, await this.translationsFrom(previous, job.request.libraryID));
    }
    const wanted = CodexPDFIdentity.kinds(job.request.outputMode);
    if (wanted.some(kind => !available[kind])) return false;
    job.request.importedKinds = Object.fromEntries(wanted.map(kind => [kind, available[kind]]));
    job.state = "imported";
    job.progress = 100;
    job.retryAt = 0;
    job.notified = true;
    job.message = "已有可用译文，已复用；没有重复启动翻译。";
    await IOUtils.writeJSON(PathUtils.join(job.directory, "request.json"), job.request);
    const status = await IOUtils.readJSON(PathUtils.join(job.directory, "status.json"));
    await IOUtils.writeJSON(PathUtils.join(job.directory, "status.json"), { ...status,
      state: "imported", progress: 100, retryAt: 0, message: job.message,
      attachmentIDs: wanted.map(kind => available[kind]), importedAt: Date.now(),
    });
    this.attentionJobs.add(job.request.id);
    this.refreshProgress();
    return true;
  },

  async requeue(job, automatic) {
    if (await this.reuseCompleted(job)) return;
    await IOUtils.remove(PathUtils.join(job.directory, "cancel"), { ignoreAbsent: true });
    // Recovery keeps the originally selected provider. Switching the UI affects new jobs.
    const previous = job.request.config || {};
    job.request.config = { codexPath: this.getPref("codexPath", this.settings.codexPath || ""),
      provider: "codex", providerName: "Codex", model: "", reasoningEffort: "medium", ...previous,
      requestTimeout: 300, parallelBatches: 2, batchRetries: 2,
      batchSize: previous.provider === "api" ? 8 : 16, batchChars: previous.provider === "api" ? 12000 : 24000, batchWindow: 0.8 };
    if (automatic) job.request.autoRetries = (job.request.autoRetries || 0) + 1;
    job.state = automatic ? "waiting_retry" : "queued";
    job.retryAt = automatic ? Date.now() / 1000 + 60 : 0;
    job.cancelling = false;
    job.notified = false;
    job.finishedAt = null;
    job.message = automatic ? `连接中断，稍后自动恢复（${job.request.autoRetries}/2）；已完成段落会复用缓存。` : "准备恢复翻译；已完成段落会复用缓存。";
    await IOUtils.writeJSON(PathUtils.join(job.directory, "request.json"), job.request);
    await IOUtils.writeJSON(PathUtils.join(job.directory, "status.json"), {
      state: job.state, retryAt: job.retryAt, message: job.message, progress: job.progress,
      startedAt: job.startedAt, updatedAt: Date.now() / 1000,
    });
    this.attentionJobs.add(job.request.id);
    this.refreshProgress();
  },

  async recoverJobs() {
    for (const directory of await IOUtils.getChildren(this.jobsDir)) {
      try {
        const request = await IOUtils.readJSON(PathUtils.join(directory, "request.json"));
        const status = await IOUtils.readJSON(PathUtils.join(directory, "status.json"));
        if (status.state === "running" && Date.now() / 1000 - status.updatedAt > 120) {
          status.state = "failed";
          status.retryable = true;
          status.message = "上次任务意外中断；重新翻译将复用缓存。";
          await IOUtils.writeJSON(PathUtils.join(directory, "status.json"), status);
        }
        const job = { request, directory, ...status, process: null, notified: this.isTerminal(status.state) };
        this.jobs.set(request.id, job);
        if (["running", "queued", "waiting_retry"].includes(status.state) || status.state === "succeeded" && !request.localFile) this.attentionJobs.add(request.id);
      } catch (error) { Zotero.debug("Codex job recovery: " + error); }
    }
    this.jobs = new Map([...this.jobs].sort(([, a], [, b]) => (a.request.createdAt || 0) - (b.request.createdAt || 0)));
    for (const job of this.jobs.values()) {
      if (this.canRecover(job) && !await IOUtils.exists(PathUtils.join(job.directory, "cancel"))) await this.requeue(job, true);
    }
  },

  async launch(job, action = "translate") {
    if (action === "translate" && await this.reuseCompleted(job)) return;
    const python = await this.resolvePython();
    const file = Zotero.File.pathToFile(python);
    const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(file);
    const args = ["-X", "utf8", this.workerPath, action, "--request", PathUtils.join(job.directory, "request.json")];
    if (action === "doctor") args.push("--online");
    process.runwAsync(args, args.length);
    job.process = process;
    job.state = "starting";
    job.startedAt = Date.now();
    job.message = action === "doctor" ? "检查 Codex 在线连接" : "启动 PDF 翻译";
    job.launcherPath = python;
    if (!job.request.localFile && (!this.workbench || this.workbench.closed)) this.showJobProgress(job);
    this.updateJobProgress(job);
  },

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.state === "waiting_retry") {
          if (job.retryAt > Date.now() / 1000) continue;
          job.state = "queued";
          job.retryAt = 0;
          await IOUtils.writeJSON(PathUtils.join(job.directory, "status.json"), { state: "queued", message: "正在恢复翻译" });
        }
        if (job.state === "queued" || job.state === "imported") continue;
        try {
          const status = await IOUtils.readJSON(PathUtils.join(job.directory, "status.json"));
          if (job.state === "starting" && status.state === "queued" && Date.now() - job.startedAt < 60000) continue;
          // Windows launcher handles are not a reliable worker liveness signal.
          // The worker's own heartbeat remains authoritative after launch.
          const heartbeat = status.updatedAt ? status.updatedAt * 1000 : job.startedAt;
          const stale = heartbeat && Date.now() - heartbeat > 120000;
          if ((status.state === "queued" && Date.now() - job.startedAt > 60000) ||
              (status.state === "running" && stale)) {
            status.state = "failed";
            status.retryable = true;
            status.message = "后台任务已失去响应；请查看任务目录中的 worker.log。重新翻译可复用缓存。";
            await IOUtils.writeJSON(PathUtils.join(job.directory, "status.json"), status);
          }
          Object.assign(job, status);
          if (this.canRecover(job)) {
            await this.requeue(job, true);
            continue;
          }
          if (job.state === "succeeded" && !job.request.doctor && !job.request.localFile) await this.importOutputs(job);
          this.updateJobProgress(job);
          if (this.isTerminal(job.state) && !job.notified) {
            job.notified = true;
            if (!this.workbench || this.workbench.closed) {
              this.notify(job.state === "imported" ? "译文已加入 Zotero" : "Codex PDF 翻译", job.message, job.state === "failed");
            }
          }
        } catch (error) {
          job.message = "挂回或读取任务失败：" + error.message;
          this.updateJobProgress(job);
          Zotero.logError(error);
        }
      }
      const busy = [...this.jobs.values()].some(j => ["starting", "running", "waiting_retry"].includes(j.state));
      const next = [...this.jobs.values()].find(j => j.state === "queued");
      if (!busy && next) {
        try { await this.launch(next, next.request.doctor ? "doctor" : "translate"); }
        catch (error) {
          next.state = "failed";
          next.message = error.message;
          next.finishedAt = Date.now() / 1000;
          next.retryable = false;
          next.notified = true;
          await IOUtils.writeJSON(PathUtils.join(next.directory, "status.json"), {
            state: "failed", message: error.message, finishedAt: next.finishedAt, retryable: false,
          });
          this.updateJobProgress(next);
          this.notify("翻译环境未就绪", error.message, true);
        }
      }
    } finally { this.ticking = false; this.refreshProgress(); }
  },

  importOutputs(job) {
    const task = this.importTail.catch(e => Zotero.logError(e)).then(() => this._importOutputs(job));
    this.importTail = task;
    return task;
  },

  async findImportedOutput(job, output) {
    const request = job.request;
    const direct = request.importedKinds?.[output.kind] || request.importedPaths?.[output.path] || request.existingAttachments?.[output.kind];
    if (await this.usableAttachment(direct, request.libraryID)) return Number(direct);
    for (const previous of await this.matchingJobs(request)) {
      const known = await this.translationsFrom(previous, request.libraryID);
      if (known[output.kind]) return known[output.kind];
    }
    // Recover an import interrupted after the attachment was saved but before its ID was recorded.
    const source = Zotero.Items.get(request.sourceItemID);
    const parent = source?.parentID && Zotero.Items.get(source.parentID);
    if (!parent || !await IOUtils.exists(output.path)) return null;
    const hash = await Zotero.Utilities.Internal.md5Async(output.path);
    for (const id of parent.getAttachments()) {
      const item = await this.usableAttachment(id, request.libraryID);
      const prefix = output.kind === "mono" ? "[Codex 中文] " : "[Codex 对照] ";
      if (!item || !item.getField("title").startsWith(prefix)) continue;
      if (await Zotero.Utilities.Internal.md5Async(await item.getFilePathAsync()) === hash) return id;
    }
    return null;
  },

  async _importOutputs(job) {
    const request = job.request;
    const source = Zotero.Items.get(request.sourceItemID);
    if (!source || source.key !== request.sourceItemKey || source.libraryID !== request.libraryID || source.deleted) {
      throw new Error("原 PDF 条目已移除；译文仍保存在任务输出目录。");
    }
    if (request.parentItemID) {
      const parent = Zotero.Items.get(request.parentItemID);
      if (!parent || parent.deleted) throw new Error("原文献条目已移除；译文仍保存在任务输出目录。");
    }
    await this.fingerprint(request, job.directory);
    request.importedPaths ||= {};
    request.importedKinds ||= {};
    for (const output of job.outputs) {
      const existing = await this.findImportedOutput(job, output);
      if (existing) {
        request.importedPaths[output.path] = existing;
        request.importedKinds[output.kind] = existing;
        await IOUtils.writeJSON(PathUtils.join(job.directory, "request.json"), request);
        continue;
      }
      const prefix = output.kind === "mono" ? "[Codex 中文] " : "[Codex 对照] ";
      const attachment = await Zotero.Attachments.importFromFile({
        file: output.path, libraryID: request.libraryID, parentItemID: request.parentItemID || undefined,
        collections: request.parentItemID ? undefined : request.collections,
        title: prefix + request.title, contentType: "application/pdf",
        fileBaseName: output.kind === "mono" ? "Codex-translated" : "Codex-bilingual",
      });
      this.imports.add(attachment.id);
      attachment.addTag("codex-pdf-translation");
      await attachment.saveTx();
      request.importedPaths[output.path] = attachment.id;
      request.importedKinds[output.kind] = attachment.id;
      await IOUtils.writeJSON(PathUtils.join(job.directory, "request.json"), request);
    }
    const available = await this.translationsFrom(job, request.libraryID);
    const incomplete = CodexPDFIdentity.kinds(request.outputMode).filter(kind => !available[kind]);
    job.state = incomplete.length ? "failed" : "imported";
    job.progress = incomplete.length ? 99 : 100;
    job.retryable = false;
    job.message = incomplete.length ? "已有译文附件在处理期间被删除或无法读取；再次点击翻译会只补缺少的版本。" : "中文 / 对照 PDF 已挂回原文献条目。";
    const statusPath = PathUtils.join(job.directory, "status.json");
    const previousStatus = await IOUtils.readJSON(statusPath);
    await IOUtils.writeJSON(statusPath, { ...previousStatus,
      state: job.state, progress: job.progress, retryable: false, message: job.message, outputs: job.outputs, requests: job.requests, batches: job.batches,
      attachmentIDs: [...new Set([...Object.values(request.importedPaths), ...Object.values(request.existingAttachments || {})])], importedAt: Date.now(),
    });
  },

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job || this.isTerminal(job.state)) return;
    await IOUtils.writeUTF8(PathUtils.join(job.directory, "cancel"), "cancel");
    this.attentionJobs.add(id);
    job.cancelling = true;
    if (["queued", "waiting_retry"].includes(job.state)) {
      job.state = "cancelled";
      job.message = "已取消排队";
      job.finishedAt = Date.now() / 1000;
      await IOUtils.writeJSON(PathUtils.join(job.directory, "status.json"), {
        state: "cancelled", message: job.message, finishedAt: job.finishedAt,
      });
    }
    this.refreshProgress();
  },

  async cancelAll() {
    for (const id of this.jobs.keys()) await this.cancel(id);
  },

  async checkEnvironment() {
    const id = "check-" + Zotero.Utilities.randomString(8);
    const directory = PathUtils.join(this.jobsDir, id);
    await IOUtils.makeDirectory(directory);
    const request = { id, doctor: true, config: this.config(), createdAt: Date.now(), title: "在线环境检查" };
    await IOUtils.writeJSON(PathUtils.join(directory, "request.json"), request);
    await IOUtils.writeJSON(PathUtils.join(directory, "status.json"), { state: "queued", message: "等待环境检查" });
    this.jobs.set(id, { request, directory, state: "queued", message: "等待环境检查" });
    this.showJobProgress(this.jobs.get(id));
    await this.tick();
  },

  openSettings() {
    Zotero.Utilities.Internal.openPreferences(this.paneID);
  },

  reveal(path) {
    Zotero.File.pathToFile(path || this.stateDir).reveal();
  },

  async writeTestReport() {
    const report = { ok: true, version, zoteroVersion: Zotero.version, timestamp: Date.now(),
      menus: this.menus, paneID: this.paneID, workerPath: this.workerPath,
      windows: Zotero.getMainWindows().length, stateDir: this.stateDir, progressPanels: this.progressViews.size,
      pythonPath: this.getPref("pythonPath", this.settings.pythonPath || "") };
    await IOUtils.writeJSON(PathUtils.join(this.stateDir, "startup.json"), report);
    const path = this.getPref("testReport", "");
    if (path) await IOUtils.writeJSON(path, report);
  },

  async shutdown() {
    this.workbench?.close();
    if (this.connections) await this.connections.stop();
    if (this.timer) clearInterval(this.timer);
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    Zotero.Reader.unregisterEventListener("renderToolbar", this.toolbarHandler);
    for (const id of this.menus) Zotero.MenuManager.unregisterMenu(id);
    for (const button of this.readerButtons) {
      try { button.remove(); } catch (error) { /* A closed reader may have invalidated its DOM. */ }
    }
    this.readerButtons.clear();
    for (const window of [...this.progressViews.keys()]) this.removeWindow(window);
    // Background workers finish and save results. Startup recovers them after re-enabling.
  },
};
