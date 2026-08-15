const test = require("node:test");
const assert = require("node:assert/strict");
globalThis.LibbySaveShared = require("../src/shared.js");
const Saved = require("../src/saved-books.js");

class MemoryStorage {
  constructor(initial = {}) { this.data = structuredClone(initial); }
  async get(keys) {
    if (typeof keys === "string") return { [keys]: this.data[keys] };
    const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
    return Object.fromEntries(list.map((key) => [key, this.data[key]]));
  }
  async set(values) { Object.assign(this.data, structuredClone(values)); }
}

function stranger(overrides = {}) {
  return {
    title: "The Stranger",
    author: "Albert Camus",
    isbns: ["9780679720201"],
    canonicalUrl: "https://openlibrary.org/works/OL888W",
    sourceUrls: ["https://www.goodreads.com/book/show/4671"],
    ...overrides
  };
}

test("saves, removes, and restores a book for Undo", async () => {
  const storage = new MemoryStorage();
  const saved = await Saved.save(storage, stranger());
  assert.equal(saved.state.items.length, 1);
  const removed = await Saved.remove(storage, saved.item.id);
  assert.ok(removed.item.removedAt);
  const restored = await Saved.restore(storage, saved.item.id);
  assert.equal(restored.item.removedAt, null);
});

test("deduplicates by ISBN before title and merges source URLs", async () => {
  const storage = new MemoryStorage();
  await Saved.save(storage, stranger());
  const again = await Saved.save(storage, stranger({
    title: "L'Étranger",
    sourceUrls: ["https://bookshop.org/p/books/the-stranger/9780679720201"]
  }));
  assert.equal(again.duplicate, true);
  assert.equal(again.state.items.length, 1);
  assert.equal(again.item.sourceUrls.length, 3);
});

test("deduplicates books without ISBN by normalized title and author", async () => {
  const storage = new MemoryStorage();
  await Saved.save(storage, { title: "On Liberty", author: "John Stuart Mill" });
  const again = await Saved.save(storage, { title: "On  Liberty!", author: "John Stuart Mill" });
  assert.equal(again.state.items.length, 1);
});

test("availability enriches asynchronously after the local save", async () => {
  const storage = new MemoryStorage();
  const saved = await Saved.save(storage, stranger({ enrichmentState: "pending" }));
  assert.equal(saved.item.enrichmentState, "pending");
  const result = { status: "available", format: "ebook", mediaId: "123", library: { slug: "nypl" }, libbyUrl: "https://libbyapp.com/library/nypl/123" };
  const enriched = await Saved.updateAvailability(storage, saved.item.id, [result]);
  assert.equal(enriched.enrichmentState, "complete");
  assert.equal(enriched.selectedLibbyMatch.mediaId, "123");
});

test("migrates legacy arrays without touching settings or imports", async () => {
  const storage = new MemoryStorage({
    saved: [stranger({ sourceUrl: "https://example.com/book" })],
    settings: { libraries: [{ slug: "nypl" }] },
    importState: { status: "running" }
  });
  const state = await Saved.read(storage);
  assert.equal(state.version, Saved.STORAGE_VERSION);
  assert.equal(state.items.length, 1);
  assert.equal(storage.data.settings.libraries[0].slug, "nypl");
  assert.equal(storage.data.importState.status, "running");
});

test("corrupted saved data is sanitized instead of breaking the popup", async () => {
  const storage = new MemoryStorage({ savedBooks: { version: 1, items: [null, "bad", { nope: true }, stranger({ id: 42, savedAt: "not-a-date" })] } });
  const state = await Saved.read(storage);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].id, "42");
  assert.ok(!Number.isNaN(Date.parse(state.items[0].savedAt)));
});

test("filters availability and media formats", () => {
  const items = [
    Saved.sanitizeBook(stranger({ id: "a", formats: ["ebook"], availability: [{ status: "available", format: "ebook" }] })),
    Saved.sanitizeBook({ title: "Audio", author: "Author", id: "b", formats: ["audiobook"], availability: [{ status: "wait", format: "audiobook" }] })
  ];
  assert.deepEqual(Saved.filterItems(items, { available: true }).map((item) => item.id), ["a"]);
  assert.deepEqual(Saved.filterItems(items, { audiobook: true }).map((item) => item.id), ["b"]);
});
