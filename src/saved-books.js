(function (root, factory) {
  const api = factory(root.LibbySaveShared);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveSavedBooks = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Shared) {
  "use strict";

  const STORAGE_VERSION = 3;
  const STORAGE_KEY = "savedBooks";

  function canonicalIsbns(book) {
    return [...new Set([
      ...(Array.isArray(book?.isbns) ? book.isbns : []), book?.isbn10, book?.isbn13
    ].filter(Boolean).map((value) => String(value).replace(/[\s-]/g, "").toUpperCase()))];
  }

  function savedKey(book) {
    const isbn = canonicalIsbns(book).sort((a, b) => b.length - a.length)[0];
    return isbn ? `isbn:${isbn}` : `book:${Shared.bookKey(book)}`;
  }

  function sameBook(left, right) {
    const a = canonicalIsbns(left);
    const b = new Set(canonicalIsbns(right));
    if (a.length && [...a].some((isbn) => b.has(isbn))) return true;
    return Shared.bookKey(left) === Shared.bookKey(right);
  }

  function sanitizeBook(value) {
    if (!value || typeof value !== "object" || !Shared.cleanTitle(value.title)) return null;
    const title = Shared.cleanTitle(value.title);
    const author = Shared.cleanAuthor(value.author || value.authors?.[0]);
    const isbns = canonicalIsbns(value);
    const sourceUrls = [...new Set([
      ...(Array.isArray(value.sourceUrls) ? value.sourceUrls : []), value.sourceUrl, value.canonicalUrl
    ].filter((url) => /^https?:\/\//i.test(String(url))))];
    return {
      id: String(value.id || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`)),
      title,
      subtitle: String(value.subtitle || ""),
      author,
      authors: Array.isArray(value.authors) && value.authors.length ? value.authors.map(String) : author ? [author] : [],
      isbns,
      isbn10: isbns.find((isbn) => isbn.length === 10) || "",
      isbn13: isbns.find((isbn) => isbn.length === 13) || "",
      coverUrl: safeUrl(value.coverUrl),
      edition: String(value.edition || ""),
      editionCount: Math.max(1, Number(value.editionCount) || 1),
      formats: [...new Set([...(value.formats || []), ...(value.formatHints || [])].filter(Boolean).map(String))],
      formatHints: [...new Set([...(value.formatHints || []), ...(value.formats || [])].filter(Boolean).map(String))],
      provider: String(value.provider || "unknown"),
      providerId: String(value.providerId || ""),
      canonicalUrl: safeUrl(value.canonicalUrl),
      source: String(value.source || "Popup search"),
      sourceUrls,
      savedAt: validDate(value.savedAt) || new Date().toISOString(),
      removedAt: validDate(value.removedAt),
      selectedLibbyMatch: validObject(value.selectedLibbyMatch),
      availability: Array.isArray(value.availability) ? value.availability.filter(validObject) : [],
      availabilityUpdatedAt: validDate(value.availabilityUpdatedAt),
      enrichmentState: ["pending", "complete", "error"].includes(value.enrichmentState) ? value.enrichmentState : "pending",
      enrichmentError: String(value.enrichmentError || "")
    };
  }

  function migrateState(raw) {
    const source = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    const items = [];
    source.forEach((value) => {
      const book = sanitizeBook(value);
      if (!book) return;
      const existing = items.find((candidate) => sameBook(candidate, book));
      if (existing) Object.assign(existing, mergeBooks(existing, book));
      else items.push(book);
    });
    return { version: STORAGE_VERSION, items };
  }

  function mergeBooks(existing, incoming) {
    const next = sanitizeBook({ ...existing, ...incoming, id: existing.id, savedAt: existing.savedAt, removedAt: null });
    next.isbns = [...new Set([...canonicalIsbns(existing), ...canonicalIsbns(incoming)])];
    next.isbn10 = next.isbns.find((isbn) => isbn.length === 10) || "";
    next.isbn13 = next.isbns.find((isbn) => isbn.length === 13) || "";
    next.sourceUrls = [...new Set([...(existing.sourceUrls || []), ...(incoming.sourceUrls || []), incoming.sourceUrl].filter(Boolean))];
    next.formats = [...new Set([...(existing.formats || []), ...(incoming.formats || []), ...(incoming.formatHints || [])])];
    next.formatHints = next.formats;
    return next;
  }

  async function read(storage) {
    const stored = await storage.get([STORAGE_KEY, "saved", "books"]);
    const source = stored[STORAGE_KEY] ?? stored.saved ?? stored.books;
    const state = migrateState(source);
    if (JSON.stringify(source) !== JSON.stringify(state)) await storage.set({ [STORAGE_KEY]: state });
    return state;
  }

  async function save(storage, value) {
    const state = await read(storage);
    const incoming = sanitizeBook(value);
    if (!incoming) throw new Error("This search result is missing a title.");
    const index = state.items.findIndex((candidate) => sameBook(candidate, incoming));
    let item;
    let duplicate = false;
    if (index >= 0) {
      duplicate = !state.items[index].removedAt;
      item = mergeBooks(state.items[index], incoming);
      state.items[index] = item;
    } else {
      item = incoming;
      state.items.unshift(item);
    }
    await storage.set({ [STORAGE_KEY]: state });
    return { state, item, duplicate };
  }

  async function remove(storage, id) {
    const state = await read(storage);
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return { state, item: null };
    item.removedAt = new Date().toISOString();
    await storage.set({ [STORAGE_KEY]: state });
    return { state, item };
  }

  async function restore(storage, id) {
    const state = await read(storage);
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return { state, item: null };
    item.removedAt = null;
    await storage.set({ [STORAGE_KEY]: state });
    return { state, item };
  }

  async function updateAvailability(storage, id, results, error) {
    const state = await read(storage);
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    item.availability = Array.isArray(results) ? results : [];
    item.availabilityUpdatedAt = new Date().toISOString();
    item.enrichmentState = error ? "error" : "complete";
    item.enrichmentError = String(error || "");
    item.selectedLibbyMatch = chooseLibbyMatch(item.availability);
    await storage.set({ [STORAGE_KEY]: state });
    return item;
  }

  function chooseLibbyMatch(results) {
    const rank = { available: 0, wait: 1, notify: 2, "not-found": 3, error: 4 };
    return [...(results || [])].filter((result) => result?.mediaId).sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || (b.score || 0) - (a.score || 0))[0] || null;
  }

  function filterItems(items, filters) {
    return (items || []).filter((item) => {
      if (filters?.removed ? !item.removedAt : item.removedAt) return false;
      const availability = item.availability || [];
      if (filters?.available && !availability.some((entry) => entry.status === "available")) return false;
      if (filters?.wait && !availability.some((entry) => entry.status === "wait")) return false;
      if (filters?.ebook && !availability.some((entry) => entry.format === "ebook") && !item.formats.includes("ebook")) return false;
      if (filters?.audiobook && !availability.some((entry) => entry.format === "audiobook") && !item.formats.includes("audiobook")) return false;
      return true;
    });
  }

  function safeUrl(value) { return /^https?:\/\//i.test(String(value || "")) ? String(value) : ""; }
  function validDate(value) { return value && !Number.isNaN(Date.parse(value)) ? String(value) : null; }
  function validObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }

  return {
    STORAGE_VERSION, STORAGE_KEY, canonicalIsbns, savedKey, sameBook, sanitizeBook,
    migrateState, mergeBooks, read, save, remove, restore, updateAvailability,
    chooseLibbyMatch, filterItems
  };
});
