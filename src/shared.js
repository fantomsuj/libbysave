(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveShared = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalize(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\([^)]*(edition|series|book|novel)[^)]*\)/gi, " ")
      .replace(/\s*[:|–—-]\s*(a novel|a memoir)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanAuthor(value) {
    return String(value || "")
      .replace(/^\s*by\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function bookKey(book) {
    return `${normalize(book.title)}::${normalize(book.author)}`;
  }

  function dedupeBooks(books) {
    const seen = new Set();
    return (books || []).filter((book) => {
      if (!book || !cleanTitle(book.title)) return false;
      const key = bookKey(book);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function tokenScore(left, right) {
    const a = new Set(normalize(left).split(" ").filter(Boolean));
    const b = new Set(normalize(right).split(" ").filter(Boolean));
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    a.forEach((token) => { if (b.has(token)) overlap += 1; });
    return (2 * overlap) / (a.size + b.size);
  }

  function matchScore(query, result) {
    const title = tokenScore(query.title, result.title);
    const author = query.author ? tokenScore(query.author, result.author || result.firstCreatorName) : 1;
    return Math.round((title * 0.72 + author * 0.28) * 100) / 100;
  }

  function librarySlug(value) {
    const input = String(value || "").trim().toLowerCase();
    if (!input) return "";
    try {
      const withProtocol = input.includes("://") ? input : `https://${input}`;
      const host = new URL(withProtocol).hostname;
      if (host.endsWith(".overdrive.com")) return host.split(".")[0];
      if (host === "libbyapp.com") {
        const match = new URL(withProtocol).pathname.match(/\/(?:library|search)\/([^/]+)/);
        return match ? match[1] : "";
      }
    } catch (_) {
      // Treat simple input as a slug below.
    }
    return input.replace(/\.overdrive\.com.*$/, "").replace(/[^a-z0-9-]/g, "");
  }

  function libbySearchUrl(slug, book) {
    return `https://libbyapp.com/search/${encodeURIComponent(slug)}/search/title-${encodeURIComponent(cleanTitle(book.title))}/creator-${encodeURIComponent(cleanAuthor(book.author))}/page-1`;
  }

  function statusFor(item) {
    if (!item) return "not-found";
    if (item.isAvailable || Number(item.availableCopies) > 0 || item.availabilityType === "always") return "available";
    if (item.isRecommendableToLibrary) return "notify";
    return "wait";
  }

  return {
    normalize,
    cleanTitle,
    cleanAuthor,
    bookKey,
    dedupeBooks,
    tokenScore,
    matchScore,
    librarySlug,
    libbySearchUrl,
    statusFor
  };
});
