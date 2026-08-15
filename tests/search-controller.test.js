const test = require("node:test");
const assert = require("node:assert/strict");
const Controller = require("../src/search-controller.js");

test("arrow keys wrap through command-palette results", () => {
  assert.deepEqual(Controller.keyboardAction("ArrowDown", 2, 3, true), { type: "move", index: 0 });
  assert.deepEqual(Controller.keyboardAction("ArrowUp", 0, 3, true), { type: "move", index: 2 });
});

test("Enter saves the highlighted result", () => {
  assert.deepEqual(Controller.keyboardAction("Enter", 1, 3, true), { type: "save", index: 1 });
});

test("Escape clears a query before closing an empty palette", () => {
  assert.equal(Controller.keyboardAction("Escape", 0, 3, true).type, "clear");
  assert.equal(Controller.keyboardAction("Escape", -1, 0, false).type, "close");
});

test("debounce only runs the final search", async () => {
  let value = "";
  const debounced = Controller.debounce((next) => { value = next; }, 10);
  debounced("first");
  debounced("second");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(value, "second");
});
