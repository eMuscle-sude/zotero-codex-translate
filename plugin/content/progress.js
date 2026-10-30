/* global Zotero */
var CodexPDFProgress = {
  namespace: "http://www.w3.org/1999/xhtml",
  activeStates: new Set(["queued", "waiting_retry", "starting", "running", "succeeded"]),

  model(job, now = Date.now()) {
    const state = job.state;
    const done = state === "imported" || (state === "succeeded" && job.request?.doctor);
    const raw = String(job.stage || "");
    let step = "preparing", label = "准备翻译";
    if (state === "queued") { step = "queued"; label = "等待翻译"; }
    else if (state === "waiting_retry") { step = "retrying"; label = "等待自动恢复"; }
    else if (state === "failed") { step = "failed"; label = "翻译失败"; }
    else if (state === "cancelled") { step = "cancelled"; label = "已取消"; }
    else if (done) { step = "done"; label = "已完成"; }
    else if (state === "succeeded" || /import/i.test(raw)) { step = "importing"; label = "正在挂回附件"; }
    else if (/Translate Paragraphs|translating/i.test(raw) || (!raw && /Codex|第.+批/.test(job.message || ""))) {
      step = "translating"; label = "正在翻译正文";
    } else if (/Typesetting|Fonts|drawing|Subset|Save PDF|generating/i.test(raw)) {
      step = "generating"; label = "正在排版生成 PDF";
    } else if (raw || state === "running") { step = "analyzing"; label = "正在分析 PDF 版式"; }
    let percent = typeof job.progress === "number" && Number.isFinite(job.progress)
      ? Math.min(99, Math.max(0, Math.floor(job.progress))) : null;
    if (done) percent = 100;
    if (state === "queued" || state === "starting") percent = null;
    if (state === "succeeded" && !done) percent = 99;
    const terminal = done || state === "failed" || state === "cancelled";
    const stamp = value => value * (value < 1e12 ? 1000 : 1);
    const start = job.startedAt ? stamp(job.startedAt) : job.request?.createdAt;
    const end = terminal ? (job.finishedAt ? stamp(job.finishedAt) : job.importedAt || now) : now;
    const elapsed = start ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
    const time = elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
    let detail = job.message || "";
    if (!terminal && job.stageTotal > 0 && Number.isFinite(job.stageCurrent)) {
      detail = `${job.stageLabel || label}：${Math.min(job.stageCurrent, job.stageTotal)} / ${job.stageTotal}`;
      if (step === "translating" && Number.isFinite(job.activeBatches)) detail += ` · ${job.activeBatches} 路运行 · 已完成 ${job.completedBatches || 0} 批`;
      else if (step === "translating" && job.batches) detail += ` · 第 ${job.batches} 批`;
    } else if (!terminal && step === "translating" && job.requests) {
      detail = `已完成 ${job.requests} 组文本翻译${job.batches ? ` · 正在处理第 ${job.batches} 批` : ""}`;
    }
    if (!terminal && (state === "waiting_retry" || job.retryingBatches > 0)) {
      step = "retrying";
      label = "连接中断，自动重试中";
      const seconds = Math.max(0, Math.ceil((job.retryAt || 0) - now / 1000));
      detail = seconds ? `${seconds} 秒后重试；已完成段落会保留。${job.activeBatches ? ` 另有 ${job.activeBatches} 批正在运行。` : ""}` : "正在恢复连接；已完成段落会保留。";
    }
    if (job.cancelling && !terminal) { label = "正在取消"; detail = "正在停止后台翻译，请稍候…"; }
    return { id: job.request?.id, title: job.request?.title || "PDF 翻译", state, step, label,
      percent, elapsed, time, detail, terminal, failed: state === "failed", cancelling: !!job.cancelling };
  },

  attach(window, api) {
    const doc = window.document;
    if (doc.getElementById("codex-pdf-progress-panel")) return null;
    const node = (tag, className, text) => {
      const element = doc.createElementNS(this.namespace, tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const style = node("style");
    style.id = "codex-pdf-progress-style";
    style.textContent = `
      #codex-pdf-progress-panel { position:fixed;right:18px;bottom:22px;width:min(390px,calc(100vw - 32px));
        z-index:2147483000;box-sizing:border-box;background:Canvas;color:CanvasText;color-scheme:light dark;
        border:1px solid #8996a44d;border-radius:12px;box-shadow:0 8px 32px #0003;font:13px/1.5 system-ui,sans-serif;
        overflow:hidden;isolation:isolate; }
      #codex-pdf-progress-panel[hidden] { display:none!important; }
      #codex-pdf-progress-panel * { box-sizing:border-box; }
      #codex-pdf-progress-panel .ct-header { display:flex;align-items:center;gap:9px;padding:12px 14px;background:#4488ee0c; }
      #codex-pdf-progress-panel .ct-heading { font-weight:650;flex:1;min-width:0; }
      #codex-pdf-progress-panel .ct-count { font-size:11px;opacity:.75; }
      #codex-pdf-progress-panel button { appearance:none;cursor:pointer;color:inherit;background:transparent;
        border:1px solid #8996a44d;border-radius:6px;padding:3px 8px;font:12px/1.5 system-ui; }
      #codex-pdf-progress-panel button:hover { background:#4488ee15; }
      #codex-pdf-progress-panel button:focus-visible { outline:2px solid #4285f4;outline-offset:2px; }
      #codex-pdf-progress-panel button:disabled { opacity:.45;cursor:wait; }
      #codex-pdf-progress-panel .ct-body { padding:2px 14px 12px;max-height:430px;overflow:auto; }
      #codex-pdf-progress-panel .ct-job { padding:12px 0 9px;border-top:1px solid #8996a42a; }
      #codex-pdf-progress-panel .ct-title { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550;margin-bottom:7px; }
      #codex-pdf-progress-panel .ct-phase { display:flex;justify-content:space-between;gap:10px;color:#2572dd;margin-bottom:7px; }
      #codex-pdf-progress-panel .ct-phase[data-state=failed] { color:#c93e3e; }
      #codex-pdf-progress-panel .ct-phase[data-state=imported] { color:#22835d; }
      #codex-pdf-progress-panel .ct-track { height:8px;position:relative;overflow:hidden;border-radius:8px;background:#7c8ea324;margin:7px 0 9px; }
      #codex-pdf-progress-panel .ct-fill { height:100%;background:#347ff0;border-radius:8px;transition:width .5s ease; }
      #codex-pdf-progress-panel .ct-track[data-indeterminate=true] .ct-fill { width:32%!important;animation:ct-progress-sweep 1.5s ease-in-out infinite; }
      #codex-pdf-progress-panel .ct-track[data-state=failed] .ct-fill { background:#c93e3e; }
      #codex-pdf-progress-panel .ct-track[data-state=imported] .ct-fill { background:#22835d; }
      #codex-pdf-progress-panel .ct-detail { font-size:12px;opacity:.8;overflow-wrap:anywhere;max-height:76px;overflow:auto; }
      #codex-pdf-progress-panel .ct-actions { display:flex;align-items:center;gap:7px;margin-top:10px; }
      #codex-pdf-progress-panel .ct-time { flex:1;font-size:11px;opacity:.65; }
      #codex-pdf-progress-panel .ct-queued { display:flex;align-items:center;gap:9px;padding:8px 0;border-top:1px solid #8996a42a;font-size:12px; }
      #codex-pdf-progress-panel .ct-queued-title { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #codex-pdf-progress-panel .ct-footer { display:flex;align-items:center;justify-content:space-between;margin-top:8px;font-size:11px;opacity:.75; }
      @keyframes ct-progress-sweep { from{transform:translateX(-110%)}to{transform:translateX(330%)} }
      @media (prefers-reduced-motion:reduce) { #codex-pdf-progress-panel .ct-fill { animation:none!important;transition:none; } }
    `;
    const panel = node("aside");
    panel.id = "codex-pdf-progress-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Codex PDF 翻译进度");
    const header = node("div", "ct-header");
    const heading = node("div", "ct-heading", "PDF 翻译");
    const count = node("span", "ct-count");
    const toggle = node("button", "ct-toggle", "收起");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "true");
    const body = node("div", "ct-body");
    header.append(heading, count, toggle);
    panel.append(header, body);
    doc.documentElement.append(style, panel);
    const controller = {
      window, panel, collapsed: false,
      expand() { this.collapsed = false; api.panelRequested = true; this.render(); },
      render() {
        const visible = [...api.jobs.values()].filter(job =>
          !api.isTerminal(job.state) || (job.state === "succeeded" && !job.request?.doctor) || api.attentionJobs.has(job.request?.id));
        panel.hidden = !visible.length && !api.uiPreparing && !api.lastUIError && !api.lastUINotice;
        if (panel.hidden) return;
        const running = visible.filter(j => ["starting", "running", "succeeded"].includes(j.state) && !api.isTerminal(j.state));
        const waiting = visible.filter(j => ["queued", "waiting_retry"].includes(j.state));
        const active = [...running, ...visible.filter(j => j.state === "succeeded" && !j.request?.doctor)];
        const terminal = visible.filter(j => api.isTerminal(j.state));
        const selected = active[0] || waiting[0] || terminal.at(-1);
        const current = selected && CodexPDFProgress.model(selected);
        heading.textContent = this.collapsed && current
          ? `${current.label}${current.percent === null ? "…" : ` · ${current.percent}%`}` : "PDF 翻译";
        count.textContent = `${active.length ? `${active.length} 运行中` : ""}${active.length && waiting.length ? " · " : ""}${waiting.length ? `${waiting.length} 排队` : ""}`;
        toggle.textContent = this.collapsed ? "展开" : "收起";
        toggle.setAttribute("aria-expanded", String(!this.collapsed));
        body.hidden = this.collapsed;
        body.replaceChildren();
        if (this.collapsed) return;
        if (api.uiPreparing && !visible.length) body.append(node("div", "ct-detail", "正在读取所选 PDF，马上开始…"));
        if (api.lastUIError) {
          const error = node("div", "ct-detail", api.lastUIError);
          error.setAttribute("role", "alert");
          body.append(error);
        }
        if (api.lastUINotice) {
          const notice = node("div", "ct-detail", api.lastUINotice);
          notice.setAttribute("role", "status");
          body.append(notice);
          if (api.reusedAttachments?.length) {
            const open = node("button", "ct-open-existing", "查看已有译文");
            open.type = "button";
            open.addEventListener("click", () => Zotero.Reader.open(api.reusedAttachments[0]));
            body.append(open);
          }
        }
        const cards = active.length ? active : waiting.length ? [waiting[0]] : terminal.slice(-2);
        for (const job of cards) {
          const m = CodexPDFProgress.model(job);
          const card = node("section", "ct-job");
          card.dataset.jobId = m.id;
          const title = node("div", "ct-title", m.title);
          title.title = m.title;
          const phase = node("div", "ct-phase");
          phase.dataset.state = m.state;
          phase.append(node("span", "ct-stage", m.label), node("strong", "ct-percent", m.percent === null ? (m.state === "queued" ? "排队中" : "运行中") : `${m.percent}%`));
          const track = node("div", "ct-track");
          track.dataset.state = m.state;
          track.dataset.indeterminate = String(m.percent === null && !m.terminal);
          track.setAttribute("role", "progressbar");
          track.setAttribute("aria-label", `${m.title}：${m.label}`);
          track.setAttribute("aria-valuemin", "0");
          track.setAttribute("aria-valuemax", "100");
          if (m.percent !== null) track.setAttribute("aria-valuenow", String(m.percent));
          track.setAttribute("aria-valuetext", m.percent === null ? m.label : `${m.label} ${m.percent}%`);
          const fill = node("div", "ct-fill");
          fill.style.width = `${m.percent ?? (m.terminal ? 0 : 32)}%`;
          track.append(fill);
          const detail = node("div", "ct-detail", m.detail);
          const actions = node("div", "ct-actions");
          actions.append(node("span", "ct-time", m.terminal ? `用时 ${m.time}` : m.state === "queued" ? `已等待 ${m.time}` : `已运行 ${m.time}`));
          const logs = node("button", "", "文件 / 日志");
          logs.type = "button";
          logs.addEventListener("click", () => api.reveal(job.directory));
          actions.append(logs);
          if (!m.terminal) {
            const cancel = node("button", "ct-cancel", m.cancelling ? "取消中" : "取消");
            cancel.type = "button";
            cancel.disabled = m.cancelling;
            cancel.addEventListener("click", () => api.cancel(m.id));
            actions.append(cancel);
          }
          card.append(title, phase, track, detail, actions);
          body.append(card);
        }
        for (const [index, job] of waiting.entries()) {
          if (cards.includes(job)) continue;
          const row = node("div", "ct-queued");
          row.dataset.jobId = job.request.id;
          row.append(node("span", "", `排队 ${index + 1}`));
          const title = node("span", "ct-queued-title", job.request.title);
          title.title = job.request.title;
          const cancel = node("button", "ct-cancel", "取消");
          cancel.type = "button";
          cancel.addEventListener("click", () => api.cancel(job.request.id));
          row.append(title, cancel);
          body.append(row);
        }
        const footer = node("div", "ct-footer");
        const settings = node("button", "", "全部任务与设置");
        settings.type = "button";
        settings.addEventListener("click", () => api.openSettings());
        footer.append(settings);
        if (!active.length && !waiting.length) {
          const dismiss = node("button", "ct-dismiss", "知道了");
          dismiss.type = "button";
          dismiss.addEventListener("click", () => { api.attentionJobs.clear(); api.lastUIError = ""; api.lastUINotice = ""; api.reusedAttachments = []; api.refreshProgress(); });
          footer.append(dismiss);
        } else footer.append(node("span", "", "可以继续阅读，翻译会在后台完成"));
        body.append(footer);
      },
      destroy() { panel.remove(); style.remove(); },
    };
    toggle.addEventListener("click", () => { controller.collapsed = !controller.collapsed; controller.render(); });
    controller.render();
    return controller;
  },
};
