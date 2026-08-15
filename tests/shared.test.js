const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../src/shared.js");

test("normalizes punctuation and accents", () => {
  assert.equal(Shared.normalize("Café & Books!"), "cafe and books");
});

test("deduplicates equivalent title and author pairs", () => {
  const books = Shared.dedupeBooks([
    { title: "The Book", author: "Jane Doe" },
    { title: "The  Book!", author: "Jane Doe" },
    { title: "Another Book", author: "Jane Doe" }
  ]);
  assert.equal(books.length, 2);
});

test("extracts library slugs from supported inputs", () => {
  assert.equal(Shared.librarySlug("nypl"), "nypl");
  assert.equal(Shared.librarySlug("https://nypl.overdrive.com/"), "nypl");
  assert.equal(Shared.librarySlug("https://libbyapp.com/library/nypl"), "nypl");
});

test("scores close title and author matches higher", () => {
  const query = { title: "The Heaven & Earth Grocery Store", author: "James McBride" };
  const close = Shared.matchScore(query, { title: "The Heaven and Earth Grocery Store", firstCreatorName: "James McBride" });
  const far = Shared.matchScore(query, { title: "Some Other Book", firstCreatorName: "Another Writer" });
  assert.ok(close > 0.9);
  assert.ok(far < 0.2);
});

test("builds an encoded Libby search URL", () => {
  const url = Shared.libbySearchUrl("nypl", { title: "North Woods", author: "Daniel Mason" });
  assert.match(url, /^https:\/\/libbyapp\.com\/search\/nypl\//);
  assert.match(url, /title-North%20Woods/);
});

test("maps catalog availability states", () => {
  assert.equal(Shared.statusFor({ isAvailable: true }), "available");
  assert.equal(Shared.statusFor({ holdsCount: 4 }), "wait");
  assert.equal(Shared.statusFor({ isRecommendableToLibrary: true }), "notify");
  assert.equal(Shared.statusFor(null), "not-found");
});
