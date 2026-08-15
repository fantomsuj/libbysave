const test = require("node:test");
const assert = require("node:assert/strict");
globalThis.LibbySaveShared = require("../src/shared.js");
const Search = require("../src/book-search.js");

const docs = [
  {
    key: "/works/OL888W",
    title: "The Stranger",
    author_name: ["Albert Camus"],
    cover_i: 42,
    isbn: ["0679720200", "9780679720201"],
    edition_key: ["OL1M", "OL2M"],
    edition_count: 34,
    first_publish_year: 1942,
    publisher: ["Vintage"],
    format: ["Paperback", "eBook"]
  },
  {
    key: "/works/OL999W",
    title: "Stranger in a Strange Land",
    author_name: ["Robert A. Heinlein"],
    isbn: ["9780441790340"],
    edition_count: 12
  }
];

function response(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => payload
  };
}

test("searches by title and normalizes useful metadata", async () => {
  let requested;
  const provider = new Search.OpenLibraryProvider({ fetchImpl: async (url) => { requested = new URL(url); return response({ docs }); } });
  const results = await provider.search("The Stranger");
  assert.equal(requested.searchParams.get("q"), "The Stranger");
  assert.equal(results[0].title, "The Stranger");
  assert.equal(results[0].author, "Albert Camus");
  assert.equal(results[0].isbn13, "9780679720201");
  assert.deepEqual(results[0].formats, ["paperback", "ebook"]);
  assert.equal(results[0].editionCount, 34);
});

test("searches title and author fields together", async () => {
  let requested;
  const provider = new Search.OpenLibraryProvider({ fetchImpl: async (url) => { requested = new URL(url); return response({ docs }); } });
  const results = await provider.search("The Stranger by Albert Camus");
  assert.equal(requested.searchParams.get("title"), "The Stranger");
  assert.equal(requested.searchParams.get("author"), "Albert Camus");
  assert.equal(results[0].confidence, "high");
});

test("author-only natural search ranks books by that author", async () => {
  const provider = new Search.OpenLibraryProvider({ fetchImpl: async () => response({ docs: docs.slice().reverse() }) });
  const results = await provider.search("Albert Camus");
  assert.equal(results[0].author, "Albert Camus");
});

test("accepts valid ISBN-10 and ISBN-13", async () => {
  const seen = [];
  const provider = new Search.OpenLibraryProvider({ fetchImpl: async (url) => { seen.push(new URL(url).searchParams.get("isbn")); return response({ docs }); } });
  await provider.search("0679720200");
  await provider.search("9780679720201");
  assert.deepEqual(seen, ["0679720200", "9780679720201"]);
  assert.equal(Search.validIsbn("0679720200"), true);
  assert.equal(Search.validIsbn("9780679720201"), true);
});

test("recognizes common book URLs without broad page access", () => {
  const goodreads = Search.parseInput("https://www.goodreads.com/book/show/4671.The_Stranger");
  const bookshop = Search.parseInput("https://bookshop.org/p/books/the-stranger-albert-camus/9780679720201");
  const spotify = Search.parseInput("https://open.spotify.com/show/opaque-id");
  assert.equal(goodreads.recognizedUrl, true);
  assert.match(goodreads.query, /The Stranger/i);
  assert.equal(bookshop.isbn, "9780679720201");
  assert.equal(spotify.recognizedUrl, true);
});

test("minor spelling mistakes still rank the correct work first", async () => {
  const provider = new Search.OpenLibraryProvider({ fetchImpl: async () => response({ docs: docs.slice().reverse() }) });
  const results = await provider.search("The Strnger by Albert Camu");
  assert.equal(results[0].title, "The Stranger");
  assert.ok(results[0].matchScore > results[1].matchScore);
});

test("preserves multiple-edition information", () => {
  const candidate = Search.normalizeDocument(docs[0], Search.parseInput("The Stranger"));
  assert.equal(candidate.editionCount, 34);
  assert.deepEqual(candidate.editionKeys, ["OL1M", "OL2M"]);
  assert.match(candidate.edition, /1942/);
});

test("multiline parsing keeps every line for reviewed matching", () => {
  const rows = Search.parseMultiline("The Stranger — Albert Camus\nThe Great Transformation — Karl Polanyi\n\nOn Liberty — John Stuart Mill");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].parsed.author, "Albert Camus");
});

test("weak matches are labeled for review", () => {
  const ranked = Search.rankCandidates([
    Search.normalizeDocument({ key: "/works/x", title: "Completely Different", author_name: ["Nobody"] }, Search.parseInput("Home"))
  ], Search.parseInput("Home"));
  assert.equal(ranked[0].confidence, "review");
});

test("reports offline and rate-limit states cleanly", async () => {
  const offline = new Search.OpenLibraryProvider({ fetchImpl: async () => { throw new Error("network"); } });
  await assert.rejects(() => offline.search("The Stranger"), (error) => error.code === "offline");
  const limited = new Search.OpenLibraryProvider({ fetchImpl: async () => response({}, 429, { "retry-after": "2" }) });
  await assert.rejects(() => limited.search("The Stranger"), (error) => error.code === "rate-limited" && error.retryAfter === "2");
});
