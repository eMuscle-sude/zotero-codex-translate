/* global Zotero, setInterval, clearInterval */
var CodexPDFMetadata = {
  snapshot(target) {
    const editable = target?.closest?.("editable-text");
    const owner = editable?.closest("abstract-box, item-pane-header, item-box");
    const item = owner?.item;
    const input = editable?.ref;
    if (!item?.isRegularItem() || !input || editable.multipleValues) return null;
    let field;
    if (owner.localName === "abstract-box") field = "abstractNote";
    else if (owner.localName === "item-pane-header") field = owner._titleFieldID;
    else {
      field = editable.getAttribute("fieldname");
      const title = Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, "title");
      if (field !== "abstractNote" && Zotero.ItemFields.getID(field) !== title) return null;
    }
    if (!field) return null;
    const value = input.value;
    let start = input.selectionStart, end = input.selectionEnd;
    const selected = Number.isInteger(start) && Number.isInteger(end) && end > start;
    if (!selected) { start = 0; end = value.length; }
    if (!value.slice(start, end).trim()) return null;
    return { editable, input, owner, item, itemID: item.id, libraryID: item.libraryID, field,
      label: field === "abstractNote" ? "摘要" : "标题", value, storedValue: item.getField(field),
      start, end, selected, text: value.slice(start, end), canEdit: !editable.readOnly && owner.editable !== false };
  },

  check(snapshot) {
    const { editable, owner, item, field } = snapshot;
    if (!snapshot.canEdit || editable.readOnly || owner.editable === false ||
        Zotero.Libraries.get(snapshot.libraryID)?.editable === false) throw new Error("此文献库或字段只读，可以复制译文。");
    if (item.deleted || !editable.isConnected || owner.item?.id !== snapshot.itemID || editable.ref?.value !== snapshot.value) {
      throw new Error("条目或原字段已改变，请重新选中文字再翻译；当前译文仍可复制。");
    }
    const stored = item.getField(field);
    if (stored !== snapshot.storedValue && stored !== snapshot.value) throw new Error("原字段已由其他操作修改，未覆盖。请重新选择文字。");
  },

  async replace(snapshot, result) {
    if (typeof result !== "string" || !result.trim() || result.length > 32000) throw new Error("译文不能为空，且不能超过 32000 个字符。");
    this.check(snapshot);
    const { item, field, editable } = snapshot;
    const value = snapshot.value.slice(0, snapshot.start) + result + snapshot.value.slice(snapshot.end);
    const previous = item.getField(field);
    item.setField(field, value);
    try {
      await item.saveTx({ undoAction: "undo-action-edit-field", undoActionArgs: {
        field: Zotero.ItemFields.getLocalizedString(field), count: 1 } });
    } catch (error) {
      item.setField(field, previous);
      throw error;
    }
    // A focused editable-text otherwise keeps its old input until the next blur.
    if (editable.isConnected && snapshot.owner.item?.id === snapshot.itemID) editable.value = value;
    return value;
  },

  attach(window, api) {
    const document = window.document;
    const module = this;
    let pending, dialog, abstractPopup, abstractTarget, destroyed = false;
    const added = new Set();
    const capture = event => {
      try {
        pending = module.snapshot(event.target);
        if (!pending) return;
        pending.expires = Date.now() + 1500;
        // Focused abstract inputs use Gecko's native editor menu, which is not
        // exposed to plugin popup listeners. Build Zotero's normal edit menu.
        if (pending.owner.localName === "abstract-box") {
          event.preventDefault(); event.stopPropagation();
          abstractTarget = pending.editable;
          if (!abstractPopup) {
            abstractPopup = document.createXULElement("menupopup");
            abstractPopup.id = "codex-metadata-abstract-menu";
            let popupset = document.querySelector("popupset");
            if (!popupset) { popupset = document.createXULElement("popupset"); document.documentElement.append(popupset); }
            popupset.append(abstractPopup);
            abstractPopup.addEventListener("popupshowing", event => {
              if (event.target === abstractPopup) Zotero.Utilities.Internal.updateEditContextMenu(abstractPopup, abstractTarget);
            });
          }
          abstractPopup.openPopupAtScreen(event.screenX + 1, event.screenY + 1, true);
        }
      } catch (error) { pending = null; Zotero.logError(error); }
    };
    const showing = event => {
      const popup = event.target;
      if (!pending || pending.expires < Date.now() || popup.localName !== "menupopup" || popup.parentElement?.localName === "menu") return;
      const source = pending; pending = null;
      const separator = document.createXULElement("menuseparator");
      const menu = document.createXULElement("menuitem");
      menu.classList.add("codex-metadata-translate");
      menu.setAttribute("label", source.selected ? "翻译所选文字" : "翻译整个" + source.label);
      if (source.text.length > 8000) { menu.disabled = true; menu.setAttribute("label", "翻译文字（请选取不超过 8000 字符）"); }
      const hidden = event => { if (event.target === popup) remove(); };
      const remove = () => { separator.remove(); menu.remove(); popup.removeEventListener("popuphidden", hidden); added.delete(remove); };
      added.add(remove);
      menu.addEventListener("command", () => preview(source));
      popup.addEventListener("popuphidden", hidden);
      popup.append(separator, menu);
    };
    const preview = source => {
      if (dialog?.close() === false) return;
      const html = (tag, text) => {
        const element = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
        if (text !== undefined) element.textContent = text;
        return element;
      };
      const overlay = html("div"); overlay.className = "codex-metadata-overlay codex-metadata-panel";
      overlay.style.cssText = "position:fixed;right:16px;bottom:16px;width:360px;max-width:calc(100vw - 24px);z-index:2147483647;color-scheme:light dark;font:13px/1.5 system-ui";
      const card = html("section"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "false");
      card.setAttribute("aria-label", "翻译" + source.label);
      card.style.cssText = "background:Canvas;color:CanvasText;border:1px solid #8996a470;border-radius:9px;max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 4px 20px #0003";
      const header = html("div"); header.className = "codex-metadata-header";
      header.style.cssText = "display:flex;align-items:center;gap:5px;padding:8px 10px;cursor:move;touch-action:none;user-select:none";
      header.title = "拖动移动浮窗";
      const title = html("strong", source.label + "翻译"); title.style.cssText = "flex:1;font-size:13px";
      const minimize = html("button", "−"); minimize.type = "button"; minimize.className = "codex-metadata-minimize";
      minimize.setAttribute("aria-label", "收起翻译浮窗"); minimize.setAttribute("aria-expanded", "true");
      const close = html("button", "×"); close.type = "button"; close.className = "codex-metadata-close";
      for (const control of [minimize, close]) control.style.cssText = "width:25px;height:24px;border:0;background:transparent;color:inherit;border-radius:4px;font:18px system-ui;cursor:pointer";
      header.append(title, minimize, close);
      const body = html("div"); body.className = "codex-metadata-body"; body.style.cssText = "padding:0 10px 10px";
      const details = html("details"); details.style.cssText = "margin-top:7px;font-size:12px";
      const summary = html("summary", "原文与模型"); summary.style.cssText = "cursor:pointer;opacity:.65";
      const provider = html("div", "正在连接模型…"); provider.className = "codex-metadata-provider"; provider.style.cssText = "font-size:11px;opacity:.65;margin:5px 0";
      const sourceBox = html("textarea"); sourceBox.value = source.text; sourceBox.readOnly = true;
      sourceBox.setAttribute("aria-label", "原文"); sourceBox.rows = 3;
      const translated = html("textarea"); translated.className = "codex-metadata-result"; translated.rows = source.label === "标题" ? 3 : 5;
      translated.setAttribute("aria-label", "译文（可以编辑）"); translated.placeholder = "译文将在此显示，可修改后替换或复制。";
      translated.disabled = true;
      for (const box of [sourceBox, translated]) box.style.cssText = "width:100%;box-sizing:border-box;background:Canvas;color:CanvasText;border:1px solid #8996a450;border-radius:5px;padding:7px;font:13px/1.55 system-ui;resize:vertical;max-height:220px";
      details.append(summary, provider, sourceBox);
      const status = html("div", "翻译中…"); status.className = "codex-metadata-status"; status.setAttribute("role", "status"); status.style.cssText = "margin:5px 0;font-size:12px;opacity:.75;white-space:pre-wrap;overflow-wrap:anywhere;max-height:70px;overflow:auto";
      const progress = html("progress"); progress.style.cssText = "width:100%;height:3px;accent-color:#2875df";
      progress.setAttribute("aria-label", "正在翻译");
      const buttons = html("div"); buttons.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:7px";
      const button = (label, className) => { const b = html("button", label); b.type = "button"; b.className = className; b.style.cssText = "padding:4px 10px;border:1px solid #8996a470;border-radius:5px;background:Canvas;color:CanvasText;font:inherit;cursor:pointer"; buttons.append(b); return b; };
      const apply = button(source.selected ? "替换选区" : "替换字段", "codex-metadata-apply"); apply.style.cssText += ";background:#2875df;color:white";
      const copy = button("复制", "codex-metadata-copy");
      const retry = button("重试", "codex-metadata-retry"); retry.hidden = true;
      apply.disabled = true; copy.disabled = true;
      body.append(translated, progress, status, buttons, details);
      card.append(header, body);
      overlay.append(card); document.documentElement.append(overlay);
      let closed = false, working = false, jobID = "", polling = false, timer, applying = false, applied = false;
      // Cancelling/closing must never restart an already stopped controller.
      const cancellation = id => api.connections.url
        ? api.connections.raw("POST", "/text/cancel", { id }).catch(() => {}) : Promise.resolve();
      const escape = event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); view.close(); }
      };
      const fit = () => {
        if (closed || !overlay.style.left) return;
        const rect = overlay.getBoundingClientRect();
        overlay.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)) + "px";
        overlay.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8)) + "px";
      };
      let drag;
      header.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.target.closest("button")) return;
        const rect = overlay.getBoundingClientRect();
        drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        header.setPointerCapture(event.pointerId); event.preventDefault();
      });
      header.addEventListener("pointermove", event => {
        if (!drag) return;
        overlay.style.left = event.clientX - drag.x + "px"; overlay.style.top = event.clientY - drag.y + "px";
        overlay.style.right = "auto"; overlay.style.bottom = "auto"; fit();
      });
      const stopDrag = () => { drag = null; };
      header.addEventListener("pointerup", stopDrag); header.addEventListener("pointercancel", stopDrag);
      minimize.addEventListener("click", () => {
        body.hidden = !body.hidden; minimize.textContent = body.hidden ? "+" : "−";
        minimize.setAttribute("aria-expanded", String(!body.hidden));
        minimize.setAttribute("aria-label", body.hidden ? "展开翻译浮窗" : "收起翻译浮窗");
        overlay.style.width = body.hidden ? "220px" : "360px"; fit();
      });
      const view = {
        close() {
          if (closed) return true;
          if (applying) return false;
          const hadFocus = overlay.contains(document.activeElement);
          closed = true; clearInterval(timer); window.removeEventListener("resize", fit);
          if (working && jobID) cancellation(jobID);
          overlay.remove(); if (dialog === view) dialog = null;
          try {
            // Keep Zotero's item undo controller active after a metadata save.
            if (hadFocus && applied) window.ZoteroPane?.itemsView?.focus();
            else if (hadFocus && source.editable.isConnected && source.owner.item?.id === source.itemID) source.editable.focus();
          } catch (error) { /* Window closed. */ }
        },
      };
      dialog = view; card.addEventListener("keydown", escape); window.addEventListener("resize", fit);
      const render = job => {
        if (closed) return;
        provider.textContent = `${job.providerName} · ${job.model || "CLI 默认模型"} → ${api.getPref("langOut", "zh")}`;
        working = job.state === "running";
        status.textContent = job.state === "running" ? "翻译中…" : job.state === "succeeded" ? "可编辑后替换或复制" : job.message;
        progress.hidden = !working;
        title.textContent = source.label + (working ? " · 翻译中…" : job.state === "succeeded" ? "译文" : " · 翻译失败");
        close.setAttribute("aria-label", working ? "关闭并取消翻译" : "关闭翻译浮窗");
        retry.hidden = !["failed", "cancelled"].includes(job.state);
        if (job.state === "succeeded") {
          translated.disabled = false; translated.value = job.result;
          copy.disabled = false; apply.disabled = !source.canEdit;
          if (!source.canEdit) status.textContent = "当前字段只读，可复制译文";
        }
        if (!working) { clearInterval(timer); timer = null; }
      };
      const poll = async () => {
        if (closed || polling || !jobID) return;
        polling = true;
        try { render(await api.connections.request("/text/status", { id: jobID })); }
        catch (error) {
          if (!closed) { status.textContent = error.message; progress.hidden = true; retry.hidden = false; working = false; }
          clearInterval(timer); timer = null;
        } finally { polling = false; }
      };
      const start = async () => {
        if (working) return;
        if (jobID) await cancellation(jobID);
        if (closed) return;
        working = true; retry.hidden = true; apply.disabled = true; copy.disabled = true; translated.disabled = true;
        progress.hidden = false; status.textContent = "连接模型…";
        title.textContent = source.label + " · 翻译中…"; close.setAttribute("aria-label", "关闭并取消翻译");
        try {
          const job = await api.connections.request("/text/start", { text: source.text, langOut: api.getPref("langOut", "zh") });
          jobID = job.id;
          if (closed) { cancellation(jobID); return; }
          render(job);
          if (working) timer = setInterval(poll, 800);
        } catch (error) {
          if (closed) return;
          working = false; status.textContent = error.message || "文字翻译失败，请检查模型连接。";
          progress.hidden = true; retry.hidden = false; title.textContent = source.label + " · 翻译失败";
          close.setAttribute("aria-label", "关闭翻译浮窗");
        }
      };
      close.addEventListener("click", () => view.close());
      retry.addEventListener("click", start);
      copy.addEventListener("click", () => {
        Zotero.Utilities.Internal.copyTextToClipboard(translated.value);
        status.textContent = "译文已复制。";
      });
      apply.addEventListener("click", async () => {
        if (applying) return;
        applying = true; apply.disabled = true; close.disabled = true; retry.disabled = true;
        try {
          await module.replace(source, translated.value);
          applied = true;
          status.textContent = "已保存，可在 Zotero 的编辑菜单中撤销。";
          apply.textContent = "已替换";
        } catch (error) { status.textContent = error.message; apply.disabled = false; }
        finally { applying = false; close.disabled = false; }
      });
      start();
    };
    window.addEventListener("contextmenu", capture, true);
    window.addEventListener("popupshowing", showing);
    return { destroy() {
      if (destroyed) return; destroyed = true;
      dialog?.close();
      window.removeEventListener("contextmenu", capture, true);
      window.removeEventListener("popupshowing", showing);
      for (const remove of [...added]) remove(); pending = null;
      abstractPopup?.remove();
    } };
  },
};
