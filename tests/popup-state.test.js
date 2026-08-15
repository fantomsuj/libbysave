const test = require("node:test");
const assert = require("node:assert/strict");
const State = require("../popup/state.js");

test("parses title, author, and ISBN popup searches", () => {
  assert.deepEqual(State.parseSearch("The Power Broker by Robert A. Caro"), {
    title: "The Power Broker", author: "Robert A. Caro", isbn: "", query: "The Power Broker by Robert A. Caro"
  });
  assert.equal(State.parseSearch("978-0-394-72024-1").isbn, "9780394720241");
  assert.equal(State.parseSearch("  James  ").title, "James");
});

test("chooses the strongest match before availability status", () => {
  const best = State.bestResult([
    { title: "Power", score: 0.61, status: "available" },
    { title: "The Power Broker", score: 0.97, status: "wait" }
  ]);
  assert.equal(best.title, "The Power Broker");
});

test("makes uncertain matches explicit", () => {
  assert.deepEqual(State.matchTone({ score: 0.9 }), { label: "Best match", tone: "good" });
  assert.match(State.matchTone({ score: 0.65 }).label, /Possible match/);
  assert.match(State.matchTone({ score: 0.4 }).label, /Uncertain match/);
});

test("maps all major library availability states to clear UI", () => {
  assert.equal(State.availabilityView({ status: "available", format: "audiobook" }).action, "borrow");
  assert.equal(State.availabilityView({ status: "wait", estimatedWaitDays: 42 }).label, "6 week wait");
  assert.equal(State.availabilityView({ status: "wait" }).action, "hold");
  assert.equal(State.availabilityView({ status: "borrowed" }).label, "Already borrowed");
  assert.equal(State.availabilityView({ status: "on-hold" }).label, "Already on hold");
  assert.equal(State.availabilityView({ status: "signin" }).label, "Sign-in required");
  assert.equal(State.availabilityView({ status: "error", error: "Network unavailable" }).detail, "Network unavailable");
  assert.equal(State.availabilityView({ status: "not-found" }).action, "");
});

test("recent searches deduplicate case-insensitively and remain bounded", () => {
  assert.deepEqual(State.recentSearches(["James", "Orbital", "North Woods"], "james", 3), ["james", "Orbital", "North Woods"]);
});
