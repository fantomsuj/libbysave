const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Automation = require("../src/libby-automation.js");

const BOOK = { title: "North Woods", author: "Daniel Mason" };
const TAG = "Saved from LibbySave";
const AUTH = { id: "auth-safe-1", action: "borrow", title: BOOK.title, author: BOOK.author, librarySlug: "nypl", mediaId: "media-1", expiresAt: 10_000 };

function html(name) { return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"); }
function attrs(source) { return Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]])); }
function controls(source) {
  return [...source.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((match, index) => {
    const before = source.slice(0, match.index);
    const openDialogs = (before.match(/<div[^>]+role="dialog"/g) || []).length;
    const closeDialogs = (before.match(/<\/div>/g) || []).length;
    return { key: `control-${index}`, label: match[2].trim(), disabled: /disabled/.test(match[1]), inDialog: openDialogs > closeDialogs, nearbyDanger: match[2].trim() };
  });
}
function tags(source) {
  if (!/role="dialog"[^>]+(?:tag|Tag)/.test(source)) return [];
  return controls(source).filter((control) => !/^(new tag|create)$/i.test(control.label)).map((control) => ({ ...control, checked: new RegExp(`<button[^>]*aria-checked="true"[^>]*>${control.label}</button>`).test(source) }));
}
function inputs(source) {
  return [...source.matchAll(/<input([^>]*)>/g)].map((match, index) => ({ key: `input-${index}`, label: attrs(match[1])["aria-label"] || "", value: attrs(match[1]).value || "" }));
}
function resultCards(source) {
  return [...source.matchAll(/<article><h2>([^<]+)<\/h2><p class="author">([^<]+)<\/p><a[^>]+>([^<]+)<\/a><\/article>/g)]
    .map((match, index) => ({ key: `result-${index}`, title: match[1], author: match[2], cardText: `${match[1]} ${match[2]}` }));
}
function importSnapshot(name, overrides = {}) {
  const source = html(name);
  return { controls: controls(source), tags: tags(source), inputs: inputs(source), results: resultCards(source), pathKind: name.startsWith("search") ? "search" : "media", busy: /aria-busy="true"/.test(source), dialogKind: /role="dialog"[^>]+(?:tag|Tag)/.test(source) ? "tags" : "", identityMatches: true, tagConfirmation: /role="status">Saved to Saved from LibbySave/.test(source) ? "saved from libbysave" : "", ...overrides };
}
function circulationSnapshot(name, overrides = {}) {
  const source = html(name);
  return { controls: controls(source), librarySlug: "nypl", mediaId: "media-1", identityMatches: true, circulationSuccess: /role="status">Borrowed/.test(source) ? "borrow" : "", ...overrides };
}

test("waits for delayed search results without clicking", () => {
  const decision = Automation.decideImport(importSnapshot("search-loading.html"), { book: BOOK, tagName: TAG, clickedSteps: [], elapsedMs: 500 });
  assert.equal(decision.effect, "wait");
  assert.equal(decision.code, "SEARCH_LOADING");
});

test("selects one clear title and pauses on an ambiguous tie", () => {
  const exact = Automation.decideImport(importSnapshot("search-exact.html"), { book: BOOK, tagName: TAG, clickedSteps: [], elapsedMs: 500 });
  assert.equal(exact.effect, "click");
  assert.equal(exact.step, "open-title");
  const ambiguousBook = { title: "Collected Stories", author: "Jane Doe" };
  const ambiguous = Automation.decideImport(importSnapshot("search-ambiguous.html"), { book: ambiguousBook, tagName: TAG, clickedSteps: [], elapsedMs: 500 });
  assert.equal(ambiguous.effect, "pause");
  assert.equal(ambiguous.code, "AMBIGUOUS_TITLE");
});

test("finds, creates, and confirms tags as separate transitions", () => {
  const existing = Automation.decideImport(importSnapshot("tag-existing.html"), { book: BOOK, tagName: TAG, clickedSteps: [], elapsedMs: 500 });
  assert.equal(existing.step, "select-tag");
  const missing = Automation.decideImport(importSnapshot("tag-missing.html"), { book: BOOK, tagName: TAG, clickedSteps: [], elapsedMs: 500 });
  assert.equal(missing.step, "open-new-tag");
  const fill = Automation.decideImport(importSnapshot("tag-create.html"), { book: BOOK, tagName: TAG, clickedSteps: ["open-new-tag"], elapsedMs: 500 });
  assert.equal(fill.effect, "input");
  assert.equal(fill.step, "fill-tag-name");
  const create = Automation.decideImport(importSnapshot("tag-create.html"), { book: BOOK, tagName: TAG, clickedSteps: ["open-new-tag", "fill-tag-name"], elapsedMs: 500 });
  assert.equal(create.step, "create-tag");
  const saved = Automation.decideImport(importSnapshot("tag-saved.html"), { book: BOOK, tagName: TAG, clickedSteps: ["select-tag"], elapsedMs: 500 });
  assert.equal(saved.effect, "complete");
  assert.equal(saved.code, "TAG_SAVED");
});

test("import mode never emits circulation clicks", () => {
  const snapshot = importSnapshot("circulation-borrow.html", { pathKind: "media", dialogKind: "" });
  const decision = Automation.decideImport(snapshot, { book: BOOK, tagName: TAG, clickedSteps: [], elapsedMs: 13000 });
  assert.notEqual(decision.effect, "click");
  assert.ok(["TAG_CONTROL_NOT_FOUND", "AMBIGUOUS_TAG_OPENER"].includes(decision.code));
});

test("authorization is exact and expires", () => {
  assert.equal(Automation.validateAuthorization(AUTH, circulationSnapshot("circulation-borrow.html"), 9_000), "");
  assert.equal(Automation.validateAuthorization(AUTH, circulationSnapshot("circulation-borrow.html", { mediaId: "other" }), 9_000), "AUTH_PAGE_MISMATCH");
  assert.equal(Automation.validateAuthorization(AUTH, circulationSnapshot("circulation-borrow.html"), 10_001), "AUTH_EXPIRED");
});

test("circulation permits one exact primary and one dialog confirmation", () => {
  const primary = Automation.decideCirculation(circulationSnapshot("circulation-borrow.html"), { authorization: AUTH, receipts: [], clickedSteps: [], now: 9_000, elapsedMs: 100 });
  assert.equal(primary.step, "circulation-primary");
  assert.equal(primary.targetKey, "control-0");
  const confirm = Automation.decideCirculation(circulationSnapshot("circulation-confirm.html"), { authorization: AUTH, receipts: [], clickedSteps: ["circulation-primary"], now: 9_000, elapsedMs: 100 });
  assert.equal(confirm.step, "circulation-confirm");
  const replay = Automation.decideCirculation(circulationSnapshot("circulation-confirm.html"), { authorization: AUTH, receipts: [], clickedSteps: ["circulation-primary", "circulation-confirm"], now: 9_000, elapsedMs: 100 });
  assert.equal(replay.effect, "wait");
});

test("success receipts and sign-in states stop clicks", () => {
  const success = Automation.decideCirculation(circulationSnapshot("circulation-success.html"), { authorization: AUTH, receipts: [], clickedSteps: ["circulation-primary"], now: 9_000, elapsedMs: 100 });
  assert.equal(success.effect, "complete");
  const replay = Automation.decideCirculation(circulationSnapshot("circulation-borrow.html"), { authorization: AUTH, receipts: [{ authorizationId: AUTH.id, outcome: "success" }], clickedSteps: [], now: 9_000, elapsedMs: 100 });
  assert.equal(replay.code, "CIRCULATION_ALREADY_COMPLETED");
  const signIn = Automation.decideCirculation(circulationSnapshot("sign-in.html"), { authorization: AUTH, receipts: [], clickedSteps: [], now: 9_000, elapsedMs: 100 });
  assert.equal(signIn.effect, "pause");
  assert.equal(signIn.code, "CIRCULATION_SIGN_IN_REQUIRED");
});

test("selector contract forbids unrelated circulation actions", () => {
  for (const label of ["Return", "Return early", "Renew", "Remove hold", "Cancel hold", "Purchase", "Buy"]) assert.equal(Automation.isForbiddenLabel(label), true, label);
  for (const label of ["Borrow", "Place hold", "Save", "Manage tags"]) assert.equal(Automation.isForbiddenLabel(label), false, label);
});
