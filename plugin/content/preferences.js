/* global Zotero */
(function () {
  const initialize = () => {
    const api = Zotero.CodexPDFTranslate;
    const root = document.getElementById("codex-pdf-settings");
    if (!root || root.dataset.initialized) return;
    root.dataset.initialized = "true";
    const $ = id => document.getElementById("ct-" + id);
    const node = (tag, text) => { const e = document.createElementNS("http://www.w3.org/1999/xhtml", tag); if (text !== undefined) e.textContent = text; return e; };
    const fields = { python: ["pythonPath", api.settings.pythonPath || ""], codex: ["codexPath", api.settings.codexPath || ""],
      in: ["langIn", "en"], out: ["langOut", "zh"], mode: ["outputMode", "both"], pages: ["pages", ""] };
    for (const [id, [pref, fallback]] of Object.entries(fields)) $(id).value = api.getPref(pref, fallback);
    $("auto").checked = api.getPref("autoTranslate", false);
    let state, selected = "codex", busy = false, polling = false, closed = false, initialized = false, dirtyAPI = false;
    let connectionTimer, jobTimer;
    const cleanup = () => {
      closed = true; clearInterval(connectionTimer); clearInterval(jobTimer);
      try { root.querySelector("#ct-api-key").value = ""; } catch (error) { /* Pane already removed. */ }
    };
    const alive = () => { try { return !closed && root.isConnected; } catch (error) { return false; } };
    const feedback = (message, failed = false) => {
      if (!alive()) return;
      $("connection-feedback").textContent = message;
      $("connection-feedback").dataset.state = failed ? "failed" : "succeeded";
    };
    const loadForm = () => {
      if (!alive()) return;
      const profile = state?.connections.apis.find(p => p.id === selected);
      $("api-name").value = profile?.name || "";
      $("api-url").value = profile?.baseUrl || "";
      $("api-model").value = profile?.model || "";
      $("api-tokens").value = profile?.maxOutputTokens || 8192;
      $("api-key").value = "";
      $("api-key").type = "password";
      $("show-key").checked = false;
      $("api-preset").value = "custom";
      $("api-key").placeholder = profile?.hasKey ? "已加密保存；留空保留原密钥" : "填写后加密保存到本机";
      $("api-key-state").textContent = profile?.hasKey ? "已保存加密密钥。要更换密钥可重新输入；更改服务地址后需填写对应的新密钥。" : "密钥只保存在本机 Windows 用户加密存储中，不写入任务记录或源码。";
      $("remove-api").hidden = !profile;
      dirtyAPI = false;
    };
    const render = () => {
      if (!state || !alive()) return;
      const c = state.connections;
      const profile = c.apis.find(p => p.id === c.selected);
      $("active").textContent = "当前使用：" + (c.selected === "codex" ? "Codex · " + (c.codexMode === "isolated" ? "插件独立登录" : "本机登录") : profile?.name || "未选择");
      const signature = c.apis.map(p => p.id + p.name).join("|");
      if ($("provider").dataset.signature !== signature) {
        $("provider").replaceChildren();
        for (const [value, label] of [["codex", "Codex 账号登录"], ...c.apis.map(p => [p.id, p.name + " · API"]), ["new-api", "＋ 添加 API 连接"]]) {
          const option = node("option", label); option.value = value; $("provider").append(option);
        }
        $("provider").dataset.signature = signature;
      }
      $("provider").value = selected;
      $("provider").disabled = busy;
      $("codex-panel").hidden = selected !== "codex";
      $("api-panel").hidden = selected === "codex";
      const account = state.codex[c.codexMode || "shared"];
      const shared = state.codex.shared;
      const pending = ["starting", "waiting"].includes(state.login.state);
      $("account").textContent = account?.checking ? "正在检查 Codex 登录状态…" : !account?.available ? account?.message || "未找到 Codex CLI。可安装 CLI 或直接添加 API 连接。" : account.loggedIn ? (c.codexMode === "isolated" ? "已登录：本插件独立 Codex 账号" : "可用：本机 Codex 已登录") + (account.kind === "api-key" ? "（CLI 使用 API Key 认证）" : "") : "当前未登录。可使用本机已登录账号，或在浏览器中授权。";
      $("account").dataset.state = account?.loggedIn ? "succeeded" : "";
      $("use-shared").disabled = busy || !shared?.loggedIn;
      $("login").disabled = busy || pending || !shared?.available;
      $("device-login").disabled = busy || pending || !shared?.available;
      $("refresh-login").disabled = busy;
      $("cancel-login").hidden = !pending;
      $("logout").hidden = !state.codex.isolated?.loggedIn;
      $("logout").disabled = busy || pending;
      $("save-codex").disabled = busy;
      $("login-progress").hidden = !state.login.message;
      $("login-progress").textContent = (state.login.message || "") + (state.login.code ? "\n设备码：" + state.login.code : "");
      $("login-progress").dataset.state = state.login.state;
      $("auth-link-row").hidden = !pending || !state.login.url;
      $("test-result").hidden = state.test.state === "idle";
      $("test-result").textContent = state.test.message || "";
      $("test-result").dataset.state = state.test.state;
      $("test").disabled = busy || state.test.state === "running";
      $("cancel-test").hidden = state.test.state !== "running";
      $("save-api").disabled = busy;
      $("remove-api").disabled = busy;
    };
    const apply = next => {
      if (!alive()) return;
      const previousLogin = state?.login.state;
      state = next;
      if (!initialized) {
        selected = state.connections.selected;
        $("model").value = state.connections.codexModel || "";
        initialized = true;
        loadForm();
      } else if (["starting", "waiting"].includes(previousLogin) && state.login.state === "succeeded" && !dirtyAPI) selected = state.connections.selected;
      render();
    };
    const operation = async (route, body = {}, success = "") => {
      busy = true; render(); feedback("正在处理…");
      try {
        const next = await api.connections.request(route, body);
        if (!alive()) return null;
        apply(next);
        if (success) feedback(success);
        else feedback("");
        return next;
      } catch (error) { feedback(error.message || "连接操作失败，请重试。", true); return null; }
      finally { busy = false; render(); }
    };
    const refresh = async () => {
      if (!alive()) { cleanup(); return; }
      if (polling || closed || busy) return;
      polling = true;
      try { apply(await api.connections.request()); }
      catch (error) { feedback(error.message || "连接服务不可用，请检查运行环境。", true); }
      finally { polling = false; }
    };
    $("provider").addEventListener("change", async () => {
      selected = $("provider").value;
      loadForm(); render();
      if (selected === "new-api") { feedback("填写并保存后，此 API 才会用于新任务。"); return; }
      const next = await operation("/select", { id: selected }, "已切换连接，仅影响新建任务。");
      if (closed) return;
      if (!next && state) { selected = state.connections.selected; loadForm(); render(); }
    });
    $("use-shared").addEventListener("click", async () => { const next = await operation("/codex/shared", {}, "已连接本机 Codex。"); if (next) { selected = "codex"; render(); } });
    $("login").addEventListener("click", () => operation("/codex/login", {}, "请在浏览器中完成官方授权。"));
    $("device-login").addEventListener("click", () => operation("/codex/login", { device: true }, "正在获取设备码，请按提示在浏览器授权。"));
    $("cancel-login").addEventListener("click", () => operation("/codex/cancel"));
    $("logout").addEventListener("click", () => operation("/codex/logout", {}, "已退出本插件的独立登录。"));
    $("refresh-login").addEventListener("click", () => operation("/refresh"));
    $("auth-link").addEventListener("click", event => { event.preventDefault(); if (state?.login.url) Zotero.launchURL(state.login.url); });
    $("save-codex").addEventListener("click", async () => {
      const model = $("model").value.trim();
      if (await operation("/codex/model", { model }, "Codex 模型已保存，思考强度为中。")) api.setPref("model", model);
    });
    const presets = {
      custom: ["", "", ""], openai: ["OpenAI", "https://api.openai.com/v1", ""],
      deepseek: ["DeepSeek", "https://api.deepseek.com", "deepseek-flash"],
      siliconflow: ["硅基流动", "https://api.siliconflow.cn/v1", ""], ollama: ["本机 Ollama", "http://localhost:11434/v1", ""],
    };
    $("api-preset").addEventListener("change", () => {
      const values = presets[$("api-preset").value];
      for (const [index, id] of ["api-name", "api-url", "api-model"].entries()) $(id).value = values[index];
      $("api-key").value = ""; dirtyAPI = true;
    });
    for (const id of ["api-name", "api-url", "api-model", "api-key", "api-tokens"]) $(id).addEventListener("input", () => { dirtyAPI = true; });
    $("show-key").addEventListener("change", () => { $("api-key").type = $("show-key").checked ? "text" : "password"; });
    $("save-api").addEventListener("click", async () => {
      const next = await operation("/api/save", { id: selected === "new-api" ? undefined : selected,
        name: $("api-name").value, baseUrl: $("api-url").value, model: $("api-model").value,
        apiKey: $("api-key").value, maxOutputTokens: Number($("api-tokens").value) }, "API 连接已保存并选用，建议测试连接。");
      if (next) { selected = next.connections.selected; loadForm(); render(); }
    });
    $("remove-api").addEventListener("click", async () => {
      const next = await operation("/api/remove", { id: selected }, "连接和本机保存的密钥已删除。");
      if (next) { selected = next.connections.selected; loadForm(); render(); }
    });
    $("test").addEventListener("click", () => {
      if (selected === "new-api" || selected !== state?.connections.selected || selected !== "codex" && dirtyAPI) { feedback("请先保存并使用此连接，再测试。", true); return; }
      if (selected === "codex" && $("model").value.trim() !== (state?.connections.codexModel || "")) { feedback("请先保存 Codex 模型，再测试。", true); return; }
      operation("/test");
    });
    $("cancel-test").addEventListener("click", () => operation("/test/cancel"));
    $("save").addEventListener("click", async () => {
      let runtimeChanged = false;
      for (const [id, [pref, fallback]] of Object.entries(fields)) {
        const value = $(id).value.trim();
        if (["python", "codex"].includes(id) && value !== api.getPref(pref, fallback)) runtimeChanged = true;
        api.setPref(pref, value);
      }
      api.setPref("autoTranslate", $("auto").checked);
      if (runtimeChanged) await api.connections.stop();
      if (alive()) $("feedback").textContent = "设置已保存。";
    });
    $("folder").addEventListener("click", () => api.reveal());
    $("cancel").addEventListener("click", () => api.cancelAll());
    const states = { queued: "排队中", waiting_retry: "等待恢复", starting: "启动中", running: "运行中", succeeded: "等待挂回", imported: "已挂回", failed: "失败", cancelled: "已取消" };
    const renderJobs = () => {
      if (!alive()) { cleanup(); return; }
      $("jobs").replaceChildren();
      const jobs = [...api.jobs.values()].reverse().slice(0, 30);
      if (!jobs.length) $("jobs").textContent = "还没有翻译任务。打开原文 PDF，点击阅读器的“译”开始。";
      for (const job of jobs) {
        const row = node("div"); row.style.cssText = "border-top:1px solid #8996a433;margin-top:14px;padding-top:14px;overflow-wrap:anywhere";
        const m = api.progressModel(job), title = node("strong", `[${states[job.state] || job.state}] ${job.request.title}`);
        const meter = node("progress"); meter.max = 100; if (m.percent !== null) meter.value = m.percent;
        meter.style.cssText = "width:100%;height:10px;accent-color:#347ff0;margin-top:8px"; meter.setAttribute("aria-label", m.label);
        row.append(title, meter, node("div", `${m.label}${m.percent === null ? "" : ` · ${m.percent}%`} · ${m.time}`), node("div", job.message || ""));
        const files = node("button", "文件 / 日志"); files.type = "button"; files.addEventListener("click", () => api.reveal(job.directory)); row.append(files);
        if (!api.isTerminal(job.state)) { const cancel = node("button", "取消"); cancel.type = "button"; cancel.addEventListener("click", () => api.cancel(job.request.id)); row.append(cancel); }
        $("jobs").append(row);
      }
    };
    refresh(); renderJobs();
    connectionTimer = setInterval(refresh, 1500); jobTimer = setInterval(renderJobs, 2000);
    // Zotero dispatches unload on the fragment before nuking its sandbox.
    // A window listener would run after that point and become a dead wrapper.
    root.parentElement.addEventListener("unload", cleanup, { once: true });
  };
  if (document.getElementById("codex-pdf-settings")) initialize();
  else {
    const observer = new MutationObserver(() => {
      if (!document.getElementById("codex-pdf-settings")) return;
      observer.disconnect(); initialize();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
