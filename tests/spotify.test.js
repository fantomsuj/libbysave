const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

globalThis.LibbySaveShared = require("../src/shared.js");
const Spotify = require("../src/adapters/spotify.js");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

test("extracts a single Spotify audiobook with its author", () => {
  const input = fixture("spotify-single.json");
  const books = Spotify.extractRecords(input.records, input.page);
  assert.deepEqual(books.map(({ title, author, preferredFormat }) => ({ title, author, preferredFormat })), [
    { title: "The Ministry of Time", author: "Kaliane Bradley", preferredFormat: "audiobook" }
  ]);
});

test("extracts several audiobook cards from a Spotify collection", () => {
  const input = fixture("spotify-collection.json");
  const books = Spotify.extractRecords(input.records, input.page);
  assert.deepEqual(books.map((book) => book.title), ["James", "The Bright Sword", "The Women"]);
  assert.deepEqual(books.map((book) => book.author), ["Percival Everett", "Lev Grossman", "Kristin Hannah"]);
});

test("deduplicates rerendered cards and preserves multiple authors", () => {
  const input = fixture("spotify-edge-cases.json");
  const books = Spotify.extractRecords(input.records, input.page);
  assert.equal(books.length, 2);
  assert.equal(books[0].author, "Samantha Harvey");
  assert.equal(books[1].author, "Dolly Alderton and Annie Macmanus");
});

test("uses an author label instead of a narrator label", () => {
  assert.equal(Spotify.selectAuthor({
    authorCandidates: ["Narrated by Julia Whelan", "Written by Kristin Hannah"],
    text: "Audiobook"
  }), "Kristin Hannah");
});
