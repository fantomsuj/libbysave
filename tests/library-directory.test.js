const test = require("node:test");
const assert = require("node:assert/strict");
const Directory = require("../src/library-directory.js");

const payload = {
  branches: [
    {
      id: 1,
      name: "Main Library - Charlotte Mecklenburg Library",
      city: "Charlotte",
      region: "North Carolina",
      regionCode: "NC",
      postalCode: "28202",
      country: "United States",
      countryCode: "US",
      systems: [{ id: 10, websiteId: 155, name: "Charlotte Mecklenburg Library", fulfillmentId: "charlotte", isConsortium: false, branchIds: [1, 2], links: [{ name: "DigitalLibraryUrl", url: "charlotte.overdrive.com" }] }]
    },
    {
      id: 2,
      name: "Cornelius Library - Charlotte Mecklenburg Library",
      city: "Cornelius",
      region: "North Carolina",
      regionCode: "NC",
      postalCode: "28031",
      country: "United States",
      countryCode: "US",
      systems: [{ id: 10, websiteId: 155, name: "Charlotte Mecklenburg Library", fulfillmentId: "charlotte", isConsortium: false, branchIds: [1, 2], links: [{ name: "DigitalLibraryUrl", url: "charlotte.overdrive.com" }] }]
    },
    {
      id: 3,
      name: "Chapel Hill Public Library",
      city: "Chapel Hill",
      region: "North Carolina",
      regionCode: "NC",
      postalCode: "27514-3649",
      country: "United States",
      countryCode: "US",
      systems: [{ id: 11, websiteId: 95, name: "North Carolina Digital Library", fulfillmentId: "northcarolina", isConsortium: true, branchIds: [3, 4], links: [{ name: "DigitalLibraryUrl", url: "ncdigital.overdrive.com" }] }]
    },
    {
      id: 4,
      name: "New York Public Library",
      city: "New York",
      region: "New York",
      regionCode: "NY",
      postalCode: "10016",
      country: "United States",
      countryCode: "US",
      systems: [{ id: 12, websiteId: 37, name: "New York Public Library", fulfillmentId: "nypl", isConsortium: false, branchIds: [4], links: [{ name: "DigitalLibraryUrl", url: "ebooks.nypl.org" }] }]
    }
  ]
};

const libraries = Directory.librariesFromLocator(payload);

test("exact library-name search ranks first", () => {
  assert.equal(Directory.rankLibraries("New York Public Library", libraries)[0].slug, "nypl");
});

test("city and state searches find matching systems", () => {
  assert.equal(Directory.rankLibraries("Charlotte", libraries)[0].slug, "charlotte");
  assert.ok(Directory.rankLibraries("North Carolina", libraries).some((library) => library.slug === "northcarolina"));
});

test("ZIP and postal searches use branch postal data", () => {
  assert.equal(Directory.rankLibraries("28202", libraries)[0].slug, "charlotte");
});

test("fuzzy misspellings find a predictable close match", () => {
  assert.equal(Directory.rankLibraries("New Yrok Public Librarry", libraries)[0].slug, "nypl");
});

test("consortium results retain the provider indicator", () => {
  assert.equal(libraries.find((library) => library.slug === "northcarolina").isConsortium, true);
});

test("duplicate prevention and multiple selections are stable", () => {
  const charlotte = libraries.find((library) => library.slug === "charlotte");
  const nypl = libraries.find((library) => library.slug === "nypl");
  let selected = Directory.addLibrarySelection([], charlotte);
  selected = Directory.addLibrarySelection(selected, charlotte);
  assert.equal(selected.length, 1);
  selected = Directory.addLibrarySelection(selected, nypl);
  assert.deepEqual(selected.map((library) => library.slug), ["charlotte", "nypl"]);
});

test("existing name and slug settings migrate without loss", () => {
  const migrated = Directory.migrateSettings({ libraries: [{ name: "NYPL", slug: "nypl" }], targetTag: "Reading", autoCheck: false });
  assert.equal(migrated.libraries[0].slug, "nypl");
  assert.equal(migrated.libraries[0].name, "NYPL");
  assert.equal(migrated.targetTag, "Reading");
  assert.equal(migrated.autoCheck, false);
  assert.equal(migrated.settingsVersion, 2);
});

test("manual fallback accepts slugs and domains", () => {
  assert.equal(Directory.manualLibrary("NYPL", "nypl.overdrive.com").slug, "nypl");
  assert.equal(Directory.manualLibrary("", "https://libbyapp.com/library/nypl").slug, "nypl");
  assert.equal(Directory.manualLibrary("Bad", "not a slug"), null);
});

test("ranking tiers and deterministic ordering are preserved", () => {
  const ordered = Directory.rankLibraries("New York Public Library", [...libraries].reverse());
  assert.equal(ordered[0].slug, "nypl");
  const forward = Directory.rankLibraries("North Carolina", libraries).map((library) => library.slug);
  const reversed = Directory.rankLibraries("North Carolina", [...libraries].reverse()).map((library) => library.slug);
  assert.deepEqual(forward, reversed);
});

function providerWith(response, options = {}) {
  const entries = new Map();
  const cache = {
    get: async (key) => entries.get(key),
    set: async (key, value) => entries.set(key, value)
  };
  const fetcher = options.fetcher || (async () => ({ ok: true, json: async () => response }));
  return { provider: new Directory.LibraryDirectoryProvider({ fetcher, cache, now: () => 1000 }), entries };
}

test("empty provider responses return an empty list", async () => {
  const { provider } = providerWith({ branches: [] });
  assert.deepEqual(await provider.search("No Such Place"), []);
});

test("failed provider responses surface an error", async () => {
  const { provider } = providerWith(null, { fetcher: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(provider.search("Somewhere Else"), /503/);
});

test("provider caches compact ranked results", async () => {
  let calls = 0;
  const { provider } = providerWith(payload, { fetcher: async () => { calls += 1; return { ok: true, json: async () => payload }; } });
  const first = await provider.search("Charlotte Mecklenburg");
  const second = await provider.search("Charlotte Mecklenburg");
  assert.equal(first[0].slug, "charlotte");
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("direct slug/domain lookup is supported", async () => {
  const fetcher = async (url) => url.includes("autocomplete")
    ? { ok: true, json: async () => ({ branches: [] }) }
    : { ok: true, json: async () => ({ id: "nypl", fulfillmentId: "nypl", name: "New York Public Library", isConsortium: false }) };
  const { provider } = providerWith(null, { fetcher });
  assert.equal((await provider.search("nypl.overdrive.com"))[0].slug, "nypl");
});
