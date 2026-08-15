(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySavePopupState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function parseSearch(value) {
    const query = String(value || "").replace(/\s+/g, " ").trim();
    const isbn = query.replace(/[^0-9X]/gi, "");
    if (/^(?:\d{9}[\dX]|97[89]\d{10})$/i.test(isbn)) return { title: query, author: "", isbn, query };
    const parts = query.match(/^(.+?)\s+(?:by|—|–)\s+(.+)$/i);
    return { title: parts?.[1]?.trim() || query, author: parts?.[2]?.trim() || "", isbn: "", query };
  }

  function bestResult(results) {
    return [...(results || [])]
      .filter((result) => result && result.status !== "error" && result.title)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || statusRank(a.status) - statusRank(b.status))[0] || null;
  }

  function matchTone(result) {
    if (!result) return { label: "No matching edition", tone: "neutral" };
    const score = Number(result.score || 0);
    if (score >= 0.82) return { label: "Best match", tone: "good" };
    if (score >= 0.62) return { label: "Possible match — check details", tone: "warn" };
    return { label: "Uncertain match — edit search", tone: "warn" };
  }

  function availabilityView(result) {
    const format = /audio/i.test(result?.format || "") ? "Audiobook" : "Ebook";
    const status = result?.status || "error";
    if (status === "available") return { tone: "available", label: "Available now", detail: format, action: "borrow", actionLabel: "Borrow" };
    if (status === "wait") {
      const weeks = result.estimatedWaitDays ? Math.max(1, Math.ceil(result.estimatedWaitDays / 7)) : null;
      return { tone: "wait", label: weeks ? `${weeks} week wait` : result.holdsCount ? `${result.holdsCount} holds` : "Wait list", detail: format, action: "hold", actionLabel: "Place hold" };
    }
    if (status === "borrowed") return { tone: "available", label: "Already borrowed", detail: format, action: "", actionLabel: "" };
    if (status === "on-hold") return { tone: "wait", label: "Already on hold", detail: format, action: "", actionLabel: "" };
    if (status === "signin") return { tone: "neutral", label: "Sign-in required", detail: "Open Libby to continue", action: "", actionLabel: "" };
    if (status === "notify") return { tone: "neutral", label: "Not in collection", detail: "Notify Me may be available", action: "", actionLabel: "" };
    if (status === "not-found") return { tone: "neutral", label: "No matching title", detail: "Try another edition", action: "", actionLabel: "" };
    return { tone: "error", label: "Couldn’t check", detail: result?.error || "Try again", action: "", actionLabel: "" };
  }

  function recentSearches(current, query, limit) {
    const clean = String(query || "").trim();
    if (!clean) return (current || []).slice(0, limit || 5);
    return [clean, ...(current || []).filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, limit || 5);
  }

  function statusRank(status) {
    return status === "available" ? 0 : status === "wait" ? 1 : status === "notify" ? 2 : 3;
  }

  return { availabilityView, bestResult, matchTone, parseSearch, recentSearches };
});
