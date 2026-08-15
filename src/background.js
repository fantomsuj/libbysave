"use strict";

importScripts("shared.js");

const Shared = globalThis.LibbySaveShared;
const FORMATS = [
  "ebook-overdrive",
  "ebook-media-do",
  "ebook-overdrive-provisional",
  "audiobook-overdrive",
  "audiobook-overdrive-provisional"
].join(",");

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const current = await chrome.storage.local.get(["settings"]);
  if (!current.settings) {
    await chrome.storage.local.set({
      settings: { libraries: [], targetTag: "Saved from LibbySave", autoCheck: true }
    });
  }
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
      return getCirculation();
    case "RECORD_CIRCULATION_STEP":
      return recordCirculationStep(message);
    case "PAUSE_CIRCULATION":
      return pauseCirculation(message);
    case "COMPLETE_CIRCULATION":
      return completeCirculation(message);
    case "RECORD_IMPORT_STEP":
      return recordImportStep(message);
    default:
      return null;
  }
}

async function startCirculation(message) {
  const action = message.action === "borrow" ? "borrow" : message.action === "hold" ? "hold" : null;
  const result = message.result;
  const expectedStatus = action === "borrow" ? "available" : "wait";
  if (!action || !result?.mediaId || !result?.library?.slug || result.status !== expectedStatus) {
    return { ok: false, error: "This title does not have an actionable Libby result." };
  }
  const now = Date.now();
  const pendingCirculation = {
    id: crypto.randomUUID(),
    action,
    title: message.book?.title || result.title,
    author: message.book?.author || result.author,
    mediaId: String(result.mediaId),
    librarySlug: result.library.slug,
    authorizedMediaTitle: result.title,
    authorizedMediaAuthor: result.author,
    status: "authorized",
    clickedSteps: [],
    createdAt: now,
    expiresAt: now + 90 * 1000
  };
  await chrome.storage.local.set({ pendingCirculation });
  const url = result.libbyUrl || `https://libbyapp.com/library/${encodeURIComponent(result.library.slug)}/spotlight-random/page-1/${result.mediaId}`;
  const tab = await chrome.tabs.create({ url, active: true });
  return { ok: true, tabId: tab.id, pendingCirculation };
}

async function getCirculation() {
  const stored = await chrome.storage.local.get(["pendingCirculation", "circulationReceipts"]);
  const pending = stored.pendingCirculation || null;
  if (pending && pending.expiresAt <= Date.now() && pending.status !== "paused") {
    pending.status = "paused";
    pending.failureCode = "AUTH_EXPIRED";
    await chrome.storage.local.set({ pendingCirculation: pending });
  }
  return { ok: true, pendingCirculation: pending, circulationReceipts: stored.circulationReceipts || [] };
}

async function recordCirculationStep(message) {
  const allowedSteps = ["circulation-primary", "circulation-confirm"];
  const stored = await chrome.storage.local.get(["pendingCirculation", "circulationReceipts"]);
  const pending = stored.pendingCirculation;
  if (!pending || pending.id !== message.authorizationId) return { ok: false, allowed: false, code: "AUTH_NOT_CURRENT" };
  if (pending.expiresAt <= Date.now()) return { ok: false, allowed: false, code: "AUTH_EXPIRED" };
  if (pending.status === "paused") return { ok: false, allowed: false, code: "AUTH_PAUSED" };
  if ((stored.circulationReceipts || []).some((receipt) => receipt.authorizationId === pending.id && receipt.outcome === "success")) return { ok: false, allowed: false, code: "ALREADY_COMPLETED" };
  if (!allowedSteps.includes(message.step) || pending.clickedSteps.includes(message.step)) return { ok: false, allowed: false, code: "STEP_ALREADY_USED" };
  if (message.step === "circulation-confirm" && !pending.clickedSteps.includes("circulation-primary")) return { ok: false, allowed: false, code: "INVALID_STEP_ORDER" };
  pending.clickedSteps.push(message.step);
  pending.status = message.step === "circulation-confirm" ? "confirming" : "acting";
  pending.updatedAt = Date.now();
  await chrome.storage.local.set({ pendingCirculation: pending });
  return { ok: true, allowed: true, pendingCirculation: pending };
}

async function pauseCirculation(message) {
  const stored = await chrome.storage.local.get("pendingCirculation");
  const pending = stored.pendingCirculation;
  if (!pending || pending.id !== message.authorizationId) return { ok: false, code: "AUTH_NOT_CURRENT" };
  pending.status = "paused";
  pending.failureCode = String(message.code || "PAUSED").slice(0, 80);
  pending.updatedAt = Date.now();
  await chrome.storage.local.set({ pendingCirculation: pending });
  return { ok: true, pendingCirculation: pending };
}

async function completeCirculation(message) {
  const stored = await chrome.storage.local.get(["pendingCirculation", "circulationReceipts"]);
  const pending = stored.pendingCirculation;
  if (!pending || pending.id !== message.authorizationId) return { ok: false, code: "AUTH_NOT_CURRENT", circulationReceipts: stored.circulationReceipts || [] };
  const receipt = { authorizationId: pending.id, action: pending.action, librarySlug: pending.librarySlug, mediaId: pending.mediaId,
    outcome: ["success", "cancelled"].includes(message.outcome) ? message.outcome : "stopped", code: String(message.code || "").slice(0, 80), completedAt: Date.now() };
  const receipts = [receipt, ...(stored.circulationReceipts || []).filter((item) => item.authorizationId !== pending.id)].slice(0, 50);
  await chrome.storage.local.set({ circulationReceipts: receipts });
  await chrome.storage.local.remove("pendingCirculation");
  return { ok: true, circulationReceipts: receipts };
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
    updatedAt: Date.now(),
    machine: { state: "waiting-for-search-results", clickedSteps: [], code: "IMPORT_STARTED" }
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
  state.machine = { state: "waiting-for-search-results", clickedSteps: [], code: "NEXT_TITLE" };
  state.updatedAt = Date.now();
  if (state.index >= state.books.length) state.status = "complete";
  await chrome.storage.local.set({ importState: state });
  return {
    ok: true,
    importState: state,
    nextUrl: state.status === "complete" ? null : Shared.libbySearchUrl(state.librarySlug, state.books[state.index])
  };
}

async function recordImportStep(message) {
  const stored = await chrome.storage.local.get("importState");
  const state = stored.importState;
  const allowedSteps = ["open-title", "open-tags", "select-tag", "open-new-tag", "fill-tag-name", "create-tag"];
  if (!state || state.id !== message.importId || state.index !== message.index || state.status !== "running") return { ok: false, allowed: false, code: "IMPORT_NOT_CURRENT" };
  if (!allowedSteps.includes(message.step) || state.machine?.clickedSteps?.includes(message.step)) return { ok: false, allowed: false, code: "IMPORT_STEP_ALREADY_USED" };
  state.machine = state.machine || { state: "waiting-for-search-results", clickedSteps: [] };
  state.machine.clickedSteps.push(message.step);
  state.machine.state = String(message.machineState || "").slice(0, 80);
  state.machine.code = String(message.code || "").slice(0, 80);
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ importState: state });
  return { ok: true, allowed: true, importState: state };
}

async function updateImportStatus(status) {
  const stored = await chrome.storage.local.get("importState");
  if (!stored.importState) return { ok: false };
  if (!["running", "paused"].includes(status)) return { ok: false, error: "Invalid import status." };
  stored.importState.status = status;
  if (status === "running") stored.importState.machine = { state: "waiting-for-page", clickedSteps: [], code: "USER_RESUMED" };
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
