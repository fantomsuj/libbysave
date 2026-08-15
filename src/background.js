"use strict";

importScripts("shared.js", "book-search.js", "saved-books.js");

const Shared = globalThis.LibbySaveShared;
const BookSearch = globalThis.LibbySaveBookSearch;
const SavedBooks = globalThis.LibbySaveSavedBooks;
const searchProvider = new BookSearch.OpenLibraryProvider();
const searchCache = new Map();
let lastProviderRequestAt = 0;
const FORMATS = [
  "ebook-overdrive",
  "ebook-media-do",
  "ebook-overdrive-provisional",
  "audiobook-overdrive",
  "audiobook-overdrive-provisional"
].join(",");

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["settings"]);
  if (!current.settings) {
    await chrome.storage.local.set({
      settings: { libraries: [], targetTag: "Saved from LibbySave", autoCheck: true }
    });
  }
  await SavedBooks.read(chrome.storage.local);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = handleMessage(message, sender);
  if (!task) return false;
  task.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "CHECK_BOOK":
      return { ok: true, results: await checkBook(message.book, message.libraries) };
    case "CHECK_BOOKS":
      return { ok: true, results: await mapLimit(message.books || [], 3, async (book) => ({
        key: Shared.bookKey(book),
        libraries: await checkBook(book, message.libraries)
      })) };
    case "SEARCH_BOOKS":
      return { ok: true, results: await searchBooks(message.query, message.limit) };
    case "GET_SAVED_BOOKS":
      return { ok: true, savedBooks: await SavedBooks.read(chrome.storage.local) };
    case "SAVE_BOOK": {
      const saved = await SavedBooks.save(chrome.storage.local, message.book);
      return { ok: true, item: saved.item, duplicate: saved.duplicate, savedBooks: saved.state };
    }
    case "REMOVE_SAVED_BOOK": {
      const removed = await SavedBooks.remove(chrome.storage.local, message.id);
      return { ok: true, item: removed.item, savedBooks: removed.state };
    }
    case "RESTORE_SAVED_BOOK": {
      const restored = await SavedBooks.restore(chrome.storage.local, message.id);
      return { ok: true, item: restored.item, savedBooks: restored.state };
    }
    case "ENRICH_SAVED_BOOK":
      return enrichSavedBook(message.id);
    case "START_IMPORT":
      return startImport(message);
    case "GET_IMPORT":
      return { ok: true, importState: (await chrome.storage.local.get("importState")).importState || null };
    case "ADVANCE_IMPORT":
      return advanceImport(message);
    case "UPDATE_IMPORT_STATUS":
      return updateImportStatus(message.status);
    case "STOP_IMPORT":
      await chrome.storage.local.remove("importState");
      return { ok: true };
    case "START_CIRCULATION":
      return startCirculation(message);
    case "GET_CIRCULATION":
      return { ok: true, pendingCirculation: (await chrome.storage.local.get("pendingCirculation")).pendingCirculation || null };
    case "COMPLETE_CIRCULATION":
      await chrome.storage.local.remove("pendingCirculation");
      return { ok: true };
    default:
      return null;
  }
}

async function searchBooks(query, limit) {
  const parsed = BookSearch.parseInput(query);
  if (!parsed.query && !parsed.isbn) return [];
  const key = Shared.normalize([parsed.kind, parsed.query, parsed.author || ""].join(":"));
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) return cached.results;
  const waitMs = Math.max(0, 1000 - (Date.now() - lastProviderRequestAt));
  if (waitMs) await wait(waitMs);
  lastProviderRequestAt = Date.now();
  const results = await searchProvider.search(query, { limit: limit || 12, offline: globalThis.navigator?.onLine === false });
  searchCache.set(key, { savedAt: Date.now(), results });
  if (searchCache.size > 30) searchCache.delete(searchCache.keys().next().value);
  return results;
}

async function enrichSavedBook(id) {
  const state = await SavedBooks.read(chrome.storage.local);
  const book = state.items.find((item) => item.id === id);
  if (!book) return { ok: false, error: "Saved book not found." };
  try {
    const results = await checkBook(book);
    const item = await SavedBooks.updateAvailability(chrome.storage.local, id, results);
    return { ok: true, item, results };
  } catch (error) {
    const item = await SavedBooks.updateAvailability(chrome.storage.local, id, [], error.message);
    return { ok: false, item, error: error.message };
  }
}

async function startCirculation(message) {
  const action = message.action === "borrow" ? "borrow" : message.action === "hold" ? "hold" : null;
  const result = message.result;
  if (!action || !result?.mediaId || !result?.library?.slug) {
    return { ok: false, error: "This title does not have an actionable Libby result." };
  }
  const pendingCirculation = {
    id: crypto.randomUUID(),
    action,
    title: message.book?.title || result.title,
    author: message.book?.author || result.author,
    mediaId: String(result.mediaId),
    librarySlug: result.library.slug,
    createdAt: Date.now(),
    expiresAt: Date.now() + 2 * 60 * 1000
  };
  await chrome.storage.local.set({ pendingCirculation });
  const url = result.libbyUrl || `https://libbyapp.com/library/${encodeURIComponent(result.library.slug)}/spotlight-random/page-1/${result.mediaId}`;
  const tab = await chrome.tabs.create({ url, active: true });
  return { ok: true, tabId: tab.id, pendingCirculation };
}

async function checkBook(book, suppliedLibraries) {
  const stored = await chrome.storage.local.get("settings");
  const libraries = suppliedLibraries || stored.settings?.libraries || [];
  return mapLimit(libraries, 3, async (library) => {
    const slug = Shared.librarySlug(library.slug || library.url || library.name);
    if (!slug) return { library, status: "error", error: "Missing library slug" };
    const params = new URLSearchParams({
      title: Shared.cleanTitle(book.title),
      creator: Shared.cleanAuthor(book.author),
      format: FORMATS,
      perPage: "12",
      page: "1",
      "x-client-id": "dewey"
    });
    const response = await fetch(`https://thunder.api.overdrive.com/v2/libraries/${encodeURIComponent(slug)}/media?${params}`);
    if (!response.ok) throw new Error(`${library.name || slug}: catalog returned ${response.status}`);
    const payload = await response.json();
    const best = Shared.selectBestMatch(book, payload.items || []);
    if (!best) {
      return { library: { ...library, slug }, status: "not-found", searchUrl: Shared.libbySearchUrl(slug, book) };
    }
    const item = best.item;
    return {
      library: { ...library, slug },
      status: Shared.statusFor(item),
      score: best.score,
      title: item.title,
      author: item.firstCreatorName,
      format: best.format,
      isAlternative: best.isAlternative,
      availableCopies: item.availableCopies || 0,
      ownedCopies: item.ownedCopies || 0,
      holdsCount: item.holdsCount || 0,
      estimatedWaitDays: item.estimatedWaitDays ?? null,
      coverUrl: firstCover(item.covers),
      mediaId: item.id,
      libbyUrl: `https://libbyapp.com/library/${encodeURIComponent(slug)}/spotlight-random/page-1/${item.id}`,
      searchUrl: Shared.libbySearchUrl(slug, book)
    };
  });
}

async function startImport(message) {
  const books = Shared.dedupeBooks(message.books || []).map((book) => ({
    title: Shared.cleanTitle(book.title),
    author: Shared.cleanAuthor(book.author),
    sourceUrl: book.sourceUrl || ""
  }));
  const slug = Shared.librarySlug(message.librarySlug);
  if (!books.length || !slug) return { ok: false, error: "Choose a library and at least one book." };
  const importState = {
    id: crypto.randomUUID(),
    status: "running",
    phase: "search",
    index: 0,
    targetTag: String(message.targetTag || "Saved from LibbySave").trim(),
    librarySlug: slug,
    books,
    results: [],
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ importState });
  const tab = await chrome.tabs.create({ url: Shared.libbySearchUrl(slug, books[0]), active: true });
  return { ok: true, tabId: tab.id, importState };
}

async function advanceImport(message) {
  const stored = await chrome.storage.local.get("importState");
  const state = stored.importState;
  if (!state) return { ok: false, error: "No active import." };
  state.results.push({
    index: state.index,
    book: state.books[state.index],
    result: message.result || "saved",
    detail: message.detail || ""
  });
  state.index += 1;
  state.phase = "search";
  state.updatedAt = Date.now();
  if (state.index >= state.books.length) state.status = "complete";
  await chrome.storage.local.set({ importState: state });
  return {
    ok: true,
    importState: state,
    nextUrl: state.status === "complete" ? null : Shared.libbySearchUrl(state.librarySlug, state.books[state.index])
  };
}

async function updateImportStatus(status) {
  const stored = await chrome.storage.local.get("importState");
  if (!stored.importState) return { ok: false };
  stored.importState.status = status;
  stored.importState.updatedAt = Date.now();
  await chrome.storage.local.set({ importState: stored.importState });
  return { ok: true, importState: stored.importState };
}

function firstCover(covers) {
  const cover = covers && Object.values(covers)[0];
  return cover?.href || "";
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        output[index] = await mapper(items[index], index);
      } catch (error) {
        output[index] = { status: "error", error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
