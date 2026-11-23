/* global Zotero, ChromeUtils, IOUtils, PathUtils, Ci */
window.addEventListener("DOMContentLoaded", () => {
  const api = window.arguments?.[0] || Zotero.CodexPDFTranslate;
  if (!api) return;
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
  const $ = id => document.getElementById("wb-" + id);
  const html = (name, value) => {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", name);
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const button = (label, action, className = "wb-quiet") => {
    const control = html("button", label);
    control.type = "button";
    control.className = className;
    control.addEventListener("click", () => run(action));
    return control;
  };
  const feedback = (message, error = false) => {
    $("feedback").textContent = message;
    $("feedback").dataset.error = String(error);
  };
  const run = async task => {
    try { await task(); }
    catch (error) { feedback(error.message || "操作未完成，请重试。", true); }
  };
  const connectionMarkup = Zotero.File.getContentsFromURL("chrome://codex-pdf-translate/content/preferences.xhtml");
  // The Zotero pane is wrapped in XUL, which an inert XML document can't parse.
  const fragment = connectionMarkup.match(/<html:div id="codex-pdf-settings"[\s\S]*<\/html:div>/)?.[0];
  const parsed = fragment && new DOMParser().parseFromString(fragment.replace("<html:div ", '<html:div xmlns:html="http://www.w3.org/1999/xhtml" '), "application/xml");
  const settings = parsed?.getElementById("codex-pdf-settings");
  if (settings) {
    const root = document.importNode(settings, true);
    root.querySelector("h2").textContent = "模型连接";
    root.querySelector("h2 + p").hidden = true;
    const choices = [...root.querySelectorAll("select")].map(select => {
      const picker = html("details"), summary = html("summary"), options = html("div");
      picker.className = "wb-choice";
      options.className = "wb-choice-options";
      picker.append(summary, options);
      select.classList.add("wb-native-select");
      select.after(picker);
      let signature = "";
      return () => {
        picker.hidden = select.hidden;
        summary.setAttribute("aria-disabled", String(select.disabled));
        if (select.disabled || select.hidden) picker.open = false;
        const label = select.selectedOptions[0]?.label || "请选择";
        if (summary.textContent !== label) summary.textContent = label;
        const list = [...select.options].filter(option => !option.hidden).map(option => [option.value, option.label, option.disabled]);
        const next = JSON.stringify([list, select.value]);
        if (next === signature) return;
        signature = next;
        options.replaceChildren();
        for (const [value, label, disabled] of list) {
          const choice = button(label, () => {
            if (select.disabled) return;
            picker.open = false;
            summary.focus();
            if (select.value === value) return;
            select.value = value;
            summary.textContent = label;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            for (const option of options.children) option.setAttribute("aria-pressed", String(option === choice));
          });
          choice.disabled = disabled || !value;
          if (!value) continue;
          choice.setAttribute("aria-pressed", String(select.value === value));
          options.append(choice);
        }
        summary.onclick = event => { if (select.disabled) event.preventDefault(); };
        picker.onkeydown = event => {
          if (event.key !== "Escape" || !picker.open) return;
          event.preventDefault();
          picker.open = false;
          summary.focus();
        };
      };
    });
    const syncChoices = () => choices.forEach(sync => sync());
    root.addEventListener("codex-choices-updated", syncChoices);
    $("connections").append(root);
    syncChoices();
  } else feedback("模型设置页面加载失败。", true);
  $("model-jump").addEventListener("click", () => $("connections").scrollIntoView({ block: "start" }));

  $("pages").value = api.getPref("pages", "");
  const selected = name => document.querySelector(`input[name="wb-${name}"]:checked`).value;
  const setRadio = (name, value) => {
    for (const radio of document.getElementsByName("wb-" + name)) if (radio.value === value) radio.checked = true;
  };
  setRadio("output", api.getPref("outputMode", "both"));
  const pending = new Set();
  let submitting = false;
  const syncPending = () => {
    $("files").replaceChildren();
    for (const path of pending) {
      const row = html("li"), name = html("span", PathUtils.filename(path));
      name.title = path;
      const remove = button("移除", () => { pending.delete(path); syncPending(); });
      remove.disabled = submitting;
      remove.setAttribute("aria-label", "移除 " + name.textContent);
      row.append(name, remove);
      $("files").append(row);
    }
    $("start").disabled = submitting || !pending.size;
    $("start").textContent = submitting ? "正在提交…" : pending.size ? `开始翻译 (${pending.size})` : "开始翻译";
  };
  const stage = paths => {
    const pdfs = paths.filter(path => /\.pdf$/i.test(path));
    if (!pdfs.length) throw new Error("请选择已下载的 PDF 文件。");
    for (const path of pdfs) pending.add(path);
    feedback(paths.length === pdfs.length ? "" : "已跳过非 PDF 文件。", paths.length !== pdfs.length);
    syncPending();
  };
  const submit = async (paths, pages, mode, removeSubmitted = false) => {
    if (!paths.length || submitting) return;
    submitting = true;
    syncPending();
    feedback("正在提交翻译任务…");
    try {
      const { results, errors } = await api.translateFiles(paths, pages, mode);
      const submitted = results.filter(result => !result.reused).length;
      const messages = [];
      if (submitted) messages.push("已加入 " + submitted + " 个任务。");
      if (results.length > submitted) messages.push("已复用 " + (results.length - submitted) + " 个已有任务或译文。");
      if (removeSubmitted) for (const result of results) pending.delete(result.inputPath);
      feedback([...messages, ...errors].join("\n"), !!errors.length);
      if (results.length) {
        setRadio("filter", "all");
        limit = 10;
      }
      render();
    } finally { submitting = false; syncPending(); }
  };
  $("start").addEventListener("click", () => run(() => submit([...pending], $("pages").value, selected("output"), true)));
  $("browse").addEventListener("click", () => run(async () => {
    const picker = new FilePicker();
    picker.init(window, "选择要翻译的 PDF", picker.modeOpenMultiple);
    picker.appendFilter("PDF 文件", "*.pdf");
    if (await picker.show() === picker.returnOK) stage(picker.files);
  }));
  const drop = $("drop");
  document.addEventListener("dragover", event => {
    event.preventDefault();
    drop.dataset.dragging = String(drop.contains(event.target));
  });
  document.addEventListener("dragleave", event => {
    if (!drop.contains(event.relatedTarget)) delete drop.dataset.dragging;
  });
  document.addEventListener("drop", event => {
    event.preventDefault();
    delete drop.dataset.dragging;
    if (!drop.contains(event.target)) return;
    const transfer = event.dataTransfer;
    const paths = [];
    for (let i = 0; i < transfer.mozItemCount; i++) {
      try {
        const file = transfer.mozGetDataAt("application/x-moz-file", i);
        if (file) paths.push(file.QueryInterface(Ci.nsIFile).path);
      } catch (error) { /* Some sources provide DOM File values instead. */ }
    }
    if (!paths.length) {
      for (const file of Array.from(transfer.files || [])) {
        try { if (file.mozFullPath) paths.push(file.mozFullPath); }
        catch (error) { /* Ignore nonlocal browser drags. */ }
      }
    }
    run(() => stage(paths));
  });
  $("folder").addEventListener("click", () => run(() => api.reveal(api.jobsDir)));

  const openResult = async (job, output) => {
    if (output.attachmentID) {
      const attachment = await api.usableAttachment(output.attachmentID, job.request.libraryID);
      if (attachment) return Zotero.getMainWindow().ZoteroPane.viewAttachment(attachment.id);
    }
    if (!output.path || !await IOUtils.exists(output.path)) throw new Error("该译文文件已移动或删除。");
    Zotero.launchFile(output.path);
  };
  const saveResult = async (job, output) => {
    if (!await IOUtils.exists(output.path)) throw new Error("该译文文件已移动或删除。");
    const picker = new FilePicker();
    picker.init(window, "保存译文副本", picker.modeSave);
    picker.appendFilter("PDF 文件", "*.pdf");
    picker.defaultExtension = "pdf";
    picker.defaultString = (job.request.title || "PDF").replace(/\.pdf$/i, "").replace(/[<>:"/\\|?*]/g, "_").slice(0, 120)
      + (output.kind === "dual" ? " [双语].pdf" : " [译文].pdf");
    const result = await picker.show();
    if ([picker.returnOK, picker.returnReplace].includes(result) && picker.file !== output.path) {
      await IOUtils.copy(output.path, picker.file, { noOverwrite: result !== picker.returnReplace });
      feedback("已保存译文副本。");
    }
  };
  const taskGroup = model => !model.terminal ? "active" : model.step === "done" ? "done" : "inactive";
  const titles = { all: "全部", active: "进行中", done: "已完成", inactive: "失败或取消" };
  const effortLabels = { none: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", "provider-default": "服务商默认" };
  const resultsFor = job => {
    const outputs = new Map((job.outputs || []).map(output => [output.kind, output]));
    const attachments = { ...job.request.existingAttachments, ...job.request.importedKinds };
    return ["mono", "dual"].flatMap(kind => {
      const output = outputs.get(kind);
      const attachmentID = attachments[kind] || job.request.importedPaths?.[output?.path];
      return output || attachmentID ? [{ ...output, kind, attachmentID }] : [];
    });
  };
  const displayJob = (job, model, group, title, metadata, outputs) => {
    const { request } = job;
    const row = html("article");
    row.className = "wb-job";
    row.dataset.jobId = request.id;
    row.dataset.group = group;
    const heading = html("div");
    heading.className = "wb-job-heading";
    const label = html("h3", title), status = html("span", model.label);
    status.className = "wb-status";
    heading.append(label, status);
    row.append(heading, html("p", metadata));
    if (group === "active" && model.step !== "queued") {
      const progress = html("div"), bar = html("progress");
      progress.className = "wb-progress";
      bar.max = 100;
      if (model.percent !== null) {
        bar.value = model.percent;
        progress.append(html("span", model.percent + "%"));
      }
      bar.setAttribute("aria-label", model.label);
      progress.prepend(bar);
      row.append(progress);
    }
    if (group !== "done" && model.detail && model.detail !== model.label) row.append(html("p", model.detail.slice(0, 500)));
    const actions = html("div"), more = html("details"), related = html("div");
    actions.className = "wb-actions";
    more.className = "wb-actions-more";
    related.className = "wb-actions";
    if (group === "active") actions.append(button("取消", () => api.cancel(request.id)));
    if (group === "inactive" && request.localFile) {
      actions.append(button("重试", () => submit([request.inputPath], request.pages, request.outputMode), "wb-result"));
    }
    if (group !== "active") {
      for (const output of outputs) {
        const variant = output.kind === "dual" ? "双语" : "译文";
        actions.append(button("打开" + variant, () => openResult(job, output), "wb-result"));
        if (request.localFile && output.path) related.append(button("另存" + variant, () => saveResult(job, output)));
      }
    }
    const itemID = request.parentItemID || request.sourceItemID;
    if (!request.localFile && itemID) {
      related.append(button("定位条目", () => Zotero.getMainWindow().ZoteroPane.selectItems([itemID])));
    }
    related.append(button("任务文件夹", () => api.reveal(job.directory)));
    more.append(html("summary", "更多"), related);
    actions.append(more);
    row.append(actions);
    return row;
  };
  const cards = new Map();
  const dates = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  let limit = 10;
  function render() {
    const uiMessage = api.lastUIError || api.lastUINotice;
    if (uiMessage && !submitting) {
      feedback(uiMessage, !!api.lastUIError);
      api.lastUIError = "";
      api.lastUINotice = "";
    }
    const entries = [...api.jobs.values()].filter(job => !job.request.doctor)
      .sort((a, b) => (b.request.createdAt || 0) - (a.request.createdAt || 0))
      .map(job => { const model = api.progressModel(job); return { job, model, group: taskGroup(model) }; });
    const counts = { all: entries.length, active: 0, done: 0, inactive: 0 };
    for (const { group } of entries) counts[group]++;
    for (const [group, title] of Object.entries(titles)) {
      const label = $("count-" + group), text = `${title} ${counts[group]}`;
      if (label.textContent !== text) label.textContent = text;
    }
    const filter = selected("filter");
    const sorted = filter === "all" ? entries.filter(e => e.group === "active").concat(entries.filter(e => e.group !== "active"))
      : entries.filter(e => e.group === filter);
    const visible = sorted.slice(0, filter === "all" ? counts.active + limit : limit);
    $("empty").hidden = !!visible.length;
    const emptyMessage = filter === "all" ? "还没有翻译任务。" : "这里没有「" + titles[filter] + "」任务。";
    if ($("empty").textContent !== emptyMessage) $("empty").textContent = emptyMessage;
    $("more").hidden = visible.length === sorted.length;
    const container = $("jobs");
    const ids = new Set(visible.map(({ job }) => job.request.id));
    for (const [id, { node }] of cards) if (!ids.has(id)) { node.remove(); cards.delete(id); }
    visible.forEach(({ job, model, group }, index) => {
      const { request } = job;
      const parent = request.parentItemID && Zotero.Items.get(request.parentItemID);
      const basename = request.inputPath && PathUtils.filename(request.inputPath);
      const title = parent?.getField("title") || request.title || basename || "PDF";
      const source = request.localFile ? "本机 PDF" : "Zotero";
      const config = request.config || {};
      const effort = job.reasoningEffort || (config.provider === "api" ? config.apiReasoningEffort || "provider-default" : config.reasoningEffort || "medium");
      const date = new Date(request.createdAt || NaN);
      const metadata = [source, config.model || config.providerName || "Codex", "思考 " + (effortLabels[effort] || effort),
        request.pages ? "第 " + request.pages + " 页" : "全文", Number.isFinite(date.getTime()) && dates.format(date),
        parent && basename && basename !== title && basename].filter(Boolean).join(" · ");
      const outputs = resultsFor(job);
      const signature = JSON.stringify([title, metadata, group, model.label, group !== "done" && model.percent, group !== "done" && model.detail, outputs]);
      let card = cards.get(request.id);
      if (card?.signature !== signature) {
        const node = displayJob(job, model, group, title, metadata, outputs);
        if (card?.node.querySelector("details")?.open) node.querySelector("details").open = true;
        card?.node.remove();
        card = { node, signature };
        cards.set(request.id, card);
      }
      if (container.children[index] !== card.node) container.insertBefore(card.node, container.children[index] || null);
    });
  }
  for (const filter of document.getElementsByName("wb-filter")) {
    filter.addEventListener("change", () => { limit = 10; render(); });
  }
  $("more").addEventListener("click", () => { limit += 10; render(); });
  render();
  const timer = setInterval(render, 1000);
  window.addEventListener("unload", () => clearInterval(timer), { once: true });
}, { once: true });
