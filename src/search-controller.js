(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveSearchController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function keyboardAction(key, index, count, hasQuery) {
    if (key === "ArrowDown") return { type: "move", index: count ? (index + 1 + count) % count : -1 };
    if (key === "ArrowUp") return { type: "move", index: count ? (index - 1 + count) % count : -1 };
    if (key === "Enter" && count && index >= 0) return { type: "save", index };
    if (key === "Escape") return { type: hasQuery ? "clear" : "close", index: -1 };
    return { type: "none", index };
  }

  function debounce(fn, delay, timers) {
    const clock = timers || globalThis;
    let timer = null;
    return function debounced(...args) {
      if (timer) clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, delay);
    };
  }

  return { keyboardAction, debounce };
});
