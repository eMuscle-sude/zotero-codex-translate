/* Document identity is independent of filenames, model choice and retry attempts. */
var CodexPDFIdentity = {
  ranges(value = "") {
    if (!value.trim()) return [];
    const ranges = value.replace(/\s/g, "").split(",").map(part => {
      if (!/^\d+(?:-\d+)?$/.test(part)) throw new Error("页码格式应为 1-3,5，留空表示全文。");
      const [start, end = start] = part.split("-").map(Number);
      if (start < 1 || end < start || !Number.isSafeInteger(end)) throw new Error("翻译页码范围无效。");
      return [start, end];
    }).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    return merged;
  },
  pages(value = "") { return this.ranges(value).map(([a, b]) => a === b ? String(a) : `${a}-${b}`).join(","); },
  covers(existing, wanted) {
    const old = this.ranges(existing), next = this.ranges(wanted);
    return !old.length || !!next.length && next.every(([a, b]) => old.some(([x, y]) => x <= a && y >= b));
  },
  sameDocument(a, b) {
    if (a.libraryID !== b.libraryID) return false;
    if (a.sourceFingerprint && b.sourceFingerprint) return a.sourceFingerprint === b.sourceFingerprint;
    return !!a.sourceItemID && a.sourceItemID === b.sourceItemID && a.sourceItemKey === b.sourceItemKey;
  },
  coversSettings(a, b) {
    return this.sameDocument(a, b) && (a.langIn || "en").toLowerCase() === (b.langIn || "en").toLowerCase() &&
      (a.langOut || "zh").toLowerCase() === (b.langOut || "zh").toLowerCase() && this.covers(a.pages || "", b.pages || "");
  },
  kinds(mode = "both") { return mode === "both" ? ["mono", "dual"] : [mode]; },
  transient(error) {
    const text = String(error || "");
    if (/quota|usage.limit|额度|unauthorized|invalid.api.key|尚未登录|token.expired|authentication.failed|unsupported.model|model.not.found|permission.denied|401|403/i.test(text)) return false;
    return /workspace routing discovery failed|timed?\s*out|timeout|超时|超过.+秒|stream disconnected|connection|network|429|50[0234]|rate.limit|temporarily|service.unavailable/i.test(text);
  },
};
