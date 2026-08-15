(function () {
  "use strict";
  const State = globalThis.LibbySavePopupState;
  const state = new URLSearchParams(location.search).get("state") || "book";
  const result = document.querySelector("#fixtureResult");
  const empty = document.querySelector("#fixtureEmpty");
  const status = document.querySelector("#fixtureStatus");
  const list = document.querySelector("#fixtureLibraries");

  const fixtureResults = state === "already"
    ? [
        { library: "New York Public Library", status: "borrowed", format: "ebook" },
        { library: "Brooklyn Public Library", status: "on-hold", format: "ebook" }
      ]
    : state === "error"
      ? [
          { library: "New York Public Library", status: "error", error: "Libby is temporarily unavailable" },
          { library: "Brooklyn Public Library", status: "signin" }
        ]
      : [
          { library: "New York Public Library", status: "available", format: "ebook" },
          { library: "Brooklyn Public Library", status: "wait", format: "ebook", estimatedWaitDays: 42 }
        ];

  if (state === "loading") {
    status.className = "status-banner loading";
    status.textContent = "Checking your libraries…";
    list.innerHTML = `<div class="availability-skeleton"></div><div class="availability-skeleton"></div>`;
  } else if (["no-libraries", "no-results"].includes(state)) {
    result.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.querySelector("h2").textContent = state === "no-libraries" ? "Connect a library to begin" : "No search results";
    empty.querySelector("p").textContent = state === "no-libraries" ? "Add your library once, then LibbySave can check every book you search." : "Try adding the author or checking the ISBN.";
    empty.querySelector("button").classList.toggle("hidden", state !== "no-libraries");
  } else {
    fixtureResults.forEach((item) => list.append(libraryCard(item)));
    if (state === "saved" || state === "borrowed" || state === "held") {
      status.className = "status-banner success";
      status.textContent = state === "saved" ? "Successfully saved to Reading List." : state === "borrowed" ? "Successfully borrowed." : "Successfully placed on hold.";
    }
  }

  function libraryCard(item) {
    const view = State.availabilityView(item);
    const card = document.createElement("article");
    card.className = `library-card ${view.tone}`;
    const copy = document.createElement("div");
    copy.innerHTML = `<h3>${item.library}</h3><div class="availability-status"><strong>${view.label}</strong>${view.detail}</div>`;
    card.append(copy);
    if (view.action) {
      const button = document.createElement("button");
      button.className = `button ${view.action === "borrow" ? "primary" : "secondary"}`;
      button.textContent = view.actionLabel;
      card.append(button);
    }
    return card;
  }
})();
