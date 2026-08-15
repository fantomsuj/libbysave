const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Extractor = require("../src/generic-extractor.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const scan = (name, selectedText = "") => Extractor.createPipeline().extract({ html: fixture(name), selectedText, url: `https://example.com/${name}` });

test("extracts schema.org Book JSON-LD with high confidence", async () => {
  const books = await scan("json-ld.html");
  assert.equal(books[0].title, "North Woods");
  assert.equal(books[0].author, "Daniel Mason");
  assert.equal(books[0].isbn, "9780593597033");
  assert.ok(books[0].confidence >= 0.9);
});

test("extracts and validates ISBN book metadata", async () => {
  const books = await scan("isbn.html");
  assert.equal(books[0].title, "The Heaven & Earth Grocery Store");
  assert.equal(books[0].author, "James McBride");
  assert.equal(books[0].isbn, "9780593422946");
});

test("extracts repeated cards, recommendation prose, and recognized links", async () => {
  const books = await scan("recommendations.html");
  assert.ok(books.some((book) => book.title === "James" && book.author === "Percival Everett"));
  assert.ok(books.some((book) => book.title === "Martyr!" && book.author === "Kaveh Akbar"));
  assert.ok(books.some((book) => book.title === "North Woods" && book.author === "Daniel Mason"));
  assert.ok(books.some((book) => book.title === "The Safekeep"));
});

test("deduplicates the same title and author across providers", async () => {
  const books = await scan("duplicates.html");
  assert.equal(books.filter((book) => book.title === "James").length, 1);
  assert.ok(books[0].evidence.length >= 2);
});

test("rejects ambiguous prose and false positives", async () => {
  assert.deepEqual(await scan("ambiguous.html"), []);
});

test("returns an empty review list when a page has no books", async () => {
  assert.deepEqual(await scan("no-books.html"), []);
});

test("extracts explicit selected-text recommendations", async () => {
  const books = await scan("no-books.html", "The Left Hand of Darkness by Ursula K. Le Guin\nThe Dispossessed by Ursula K. Le Guin");
  assert.equal(books.length, 2);
  assert.equal(books[0].evidence[0], "selected text");
});

test("keeps optional fallback behind a provider boundary and off by default", async () => {
  let calls = 0;
  const fallbackProvider = { extract: async () => { calls += 1; return [{ title: "Fallback Book", author: "Ada Reader", confidence: 0.5, evidence: ["fallback"] }]; } };
  const defaultBooks = await Extractor.createPipeline().extract({ html: fixture("no-books.html") });
  assert.equal(calls, 0);
  assert.deepEqual(defaultBooks, []);
  const fallbackBooks = await Extractor.createPipeline({ fallbackProvider }).extract({ html: fixture("no-books.html") });
  assert.equal(calls, 1);
  assert.equal(fallbackBooks[0].title, "Fallback Book");
});

test("validates ISBN-10 and ISBN-13 checksums", () => {
  assert.equal(Extractor.validIsbn("0-306-40615-2"), "0306406152");
  assert.equal(Extractor.validIsbn("978-0-593-42294-6"), "9780593422946");
  assert.equal(Extractor.validIsbn("978-0-593-42294-7"), "");
});
