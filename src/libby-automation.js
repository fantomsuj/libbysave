(function (root, factory) {
  const api = factory(root.LibbySaveShared || (typeof require === "function" ? require("./shared.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveAutomation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Shared) {
  "use strict";

  const STATES = Object.freeze({
    WAIT_RESULTS: "waiting-for-search-results",
    SELECT_TITLE: "selecting-correct-title",
    OPEN_TAGS: "opening-tag-controls",
    FIND_TAG: "finding-existing-tag",
    CREATE_TAG: "creating-missing-tag",
    CONFIRM_TAG: "confirming-saved-tag",
    CIRCULATE: "authorized-circulation",
    CONFIRM_CIRCULATION: "confirming-circulation",
    SUCCESS: "success",
    SIGN_IN: "sign-in-required",
    AMBIGUOUS: "ambiguous-paused",
    FAILED: "failed"
  });
  const FORBIDDEN_ACTION = /^(return|return early|renew|renew loan|remove hold|cancel hold|suspend hold|purchase|buy|recommend|notify me)$/i;
  const IMPORT_CIRCULATION = /^(borrow|borrow!|borrow now|place hold|place a hold|hold)$/i;
  const SIGN_IN = /^(sign in|sign in with my card|add a library card)$/i;
  const BUSY = /^(loading|searching|please wait)$/i;
  const TAG_OPEN = /^(save|tag|add tag|manage tags)$/i;
  const NEW_TAG = /^(new tag|create tag)$/i;
  const CREATE = /^(create|create tag)$/i;

  function normalized(value) { return Shared.normalize(value); }
  function exact(value, pattern) { return pattern.test(String(value || "").trim()); }
  function safeControl(control) {
    return control && !control.disabled && !FORBIDDEN_ACTION.test(String(control.label || "").trim());
  }
  function one(controls, predicate) {
    const matches = controls.filter((control) => safeControl(control) && predicate(control));
    return { match: matches.length === 1 ? matches[0] : null, count: matches.length };
  }
  function click(state, step, target, code, explanation) {
    return { state, effect: "click", step, targetKey: target.key, code, explanation };
  }
  function pause(state, code, explanation) {
    return { state, effect: "pause", code, explanation };
  }
  function wait(state, code, explanation) {
    return { state, effect: "wait", code, explanation };
  }
  function complete(code, explanation) {
    return { state: STATES.SUCCESS, effect: "complete", code, explanation };
  }

  function decideImport(snapshot, context) {
    const elapsed = context.elapsedMs || 0;
    const controls = snapshot.controls || [];
    if (controls.some((control) => exact(control.label, SIGN_IN))) {
      return pause(STATES.SIGN_IN, "IMPORT_SIGN_IN_REQUIRED", "Libby requires the user to sign in before tagging can continue.");
    }
    if (snapshot.pathKind === "search") {
      if (snapshot.busy || controls.some((control) => exact(control.label, BUSY))) {
        return wait(STATES.WAIT_RESULTS, "SEARCH_LOADING", "Waiting for Libby's search results to finish loading.");
      }
      const candidates = (snapshot.results || []).map((result) => ({
        ...result,
        titleScore: Shared.tokenScore(context.book.title, result.title || result.cardText),
        authorScore: context.book.author ? Shared.tokenScore(context.book.author, result.author || result.cardText) : 1
      })).filter((result) => result.titleScore >= 0.82 && result.authorScore >= 0.62)
        .sort((a, b) => (b.titleScore + b.authorScore) - (a.titleScore + a.authorScore));
      if (!candidates.length) {
        return elapsed > 15000
          ? pause(STATES.FAILED, "TITLE_NOT_FOUND", "No sufficiently exact title and author match appeared before the timeout.")
          : wait(STATES.WAIT_RESULTS, "NO_SAFE_TITLE_YET", "No safe title match is available yet; waiting for delayed results.");
      }
      const top = candidates[0];
      const next = candidates[1];
      const topScore = top.titleScore * .72 + top.authorScore * .28;
      const nextScore = next ? next.titleScore * .72 + next.authorScore * .28 : 0;
      if (topScore < .82 || (next && topScore - nextScore < .12)) {
        return pause(STATES.AMBIGUOUS, "AMBIGUOUS_TITLE", "Multiple plausible search results are too close to choose safely.");
      }
      if ((context.clickedSteps || []).includes("open-title")) {
        return elapsed > 15000
          ? pause(STATES.FAILED, "TITLE_NAVIGATION_UNCONFIRMED", "The selected title did not open before the timeout.")
          : wait(STATES.SELECT_TITLE, "TITLE_CLICK_ALREADY_SENT", "Waiting for the previously selected title to open.");
      }
      return click(STATES.SELECT_TITLE, "open-title", top, "OPEN_EXACT_TITLE", "Open the single high-confidence title and author match.");
    }

    if (snapshot.pathKind !== "media" || !snapshot.identityMatches) {
      return pause(STATES.AMBIGUOUS, "WRONG_MEDIA_PAGE", "The open Libby page does not identify the expected title and library.");
    }
    const target = normalized(context.tagName);
    const saved = (snapshot.tags || []).filter((tag) => normalized(tag.label) === target && tag.checked);
    if (saved.length === 1 || snapshot.tagConfirmation === target) {
      return complete("TAG_SAVED", "The expected tag is visibly selected or confirmed by Libby.");
    }
    if (saved.length > 1) return pause(STATES.AMBIGUOUS, "DUPLICATE_SAVED_TAG", "More than one saved tag control matches the requested tag.");

    if (snapshot.dialogKind === "tags") {
      const tags = (snapshot.tags || []).filter((tag) => normalized(tag.label) === target);
      if (tags.length > 1) return pause(STATES.AMBIGUOUS, "DUPLICATE_TAG", "Multiple tag controls have the requested name.");
      if (tags.length === 1) {
        if ((context.clickedSteps || []).includes("select-tag")) {
          return elapsed > 10000
            ? pause(STATES.FAILED, "TAG_SAVE_UNCONFIRMED", "Libby did not visibly confirm the selected tag.")
            : wait(STATES.CONFIRM_TAG, "WAIT_TAG_CONFIRMATION", "Waiting for Libby to confirm the selected tag.");
        }
        return click(STATES.FIND_TAG, "select-tag", tags[0], "SELECT_EXACT_TAG", "Select the one existing tag whose complete label exactly matches the requested tag.");
      }
      const input = (snapshot.inputs || []).filter((item) => /tag.*name|name.*tag/i.test(item.label || ""));
      if (input.length > 1) return pause(STATES.AMBIGUOUS, "AMBIGUOUS_TAG_INPUT", "Multiple possible tag-name inputs are visible.");
      if (input.length === 1) {
        if (!(context.clickedSteps || []).includes("fill-tag-name")) {
          return { state: STATES.CREATE_TAG, effect: "input", step: "fill-tag-name", targetKey: input[0].key, value: context.tagName, code: "FILL_TAG_NAME", explanation: "Fill the uniquely labelled tag-name field with the requested tag." };
        }
        if (normalized(input[0].value) !== target) {
          return pause(STATES.AMBIGUOUS, "TAG_INPUT_NOT_CONFIRMED", "The tag-name field changed after it was filled; Create will not be clicked.");
        }
        const create = one(controls, (control) => exact(control.label, CREATE) && control.inDialog);
        if (create.count > 1) return pause(STATES.AMBIGUOUS, "AMBIGUOUS_CREATE_TAG", "Multiple Create controls are visible in the tag dialog.");
        if (create.match && !(context.clickedSteps || []).includes("create-tag")) {
          return click(STATES.CREATE_TAG, "create-tag", create.match, "CREATE_EXACT_TAG", "Click the single exact Create control inside the tag dialog.");
        }
        return elapsed > 10000
          ? pause(STATES.FAILED, "TAG_CREATION_UNCONFIRMED", "The new tag was not visibly created and selected.")
          : wait(STATES.CONFIRM_TAG, "WAIT_CREATED_TAG", "Waiting for Libby to confirm the newly created tag.");
      }
      const newTag = one(controls, (control) => exact(control.label, NEW_TAG) && control.inDialog);
      if (newTag.count > 1) return pause(STATES.AMBIGUOUS, "AMBIGUOUS_NEW_TAG", "Multiple New Tag controls are visible.");
      if (newTag.match && !(context.clickedSteps || []).includes("open-new-tag")) {
        return click(STATES.CREATE_TAG, "open-new-tag", newTag.match, "OPEN_NEW_TAG", "Open the single exact New Tag control inside the tag dialog.");
      }
      return elapsed > 10000
        ? pause(STATES.FAILED, "TAG_NOT_FOUND", "The tag was missing and no uniquely identified tag-creation control appeared.")
        : wait(STATES.FIND_TAG, "WAIT_TAG_CONTROLS", "Waiting for existing or new-tag controls to render.");
    }

    const opener = one(controls, (control) => exact(control.label, TAG_OPEN) && !control.inCirculationArea);
    if (opener.count > 1) return pause(STATES.AMBIGUOUS, "AMBIGUOUS_TAG_OPENER", "Multiple possible tag controls are visible.");
    if (opener.match && !(context.clickedSteps || []).includes("open-tags")) {
      return click(STATES.OPEN_TAGS, "open-tags", opener.match, "OPEN_TAG_CONTROLS", "Open the single exact tag-management control on the verified media page.");
    }
    return elapsed > 12000
      ? pause(STATES.FAILED, "TAG_CONTROL_NOT_FOUND", "No uniquely identified tag control appeared before the timeout.")
      : wait(STATES.OPEN_TAGS, "WAIT_TAG_OPENER", "Waiting for the verified media page's tag control.");
  }

  function validateAuthorization(auth, snapshot, now) {
    if (!auth || !["borrow", "hold"].includes(auth.action)) return "AUTH_MISSING";
    if (!auth.id || !auth.title || !auth.librarySlug || !auth.mediaId) return "AUTH_INCOMPLETE";
    if (auth.expiresAt <= now) return "AUTH_EXPIRED";
    if (snapshot.mediaId !== String(auth.mediaId) || snapshot.librarySlug !== auth.librarySlug || !snapshot.identityMatches) return "AUTH_PAGE_MISMATCH";
    return "";
  }

  function decideCirculation(snapshot, context) {
    const auth = context.authorization;
    const invalid = validateAuthorization(auth, snapshot, context.now || Date.now());
    if (invalid) return pause(STATES.AMBIGUOUS, invalid, "The page does not exactly match the unexpired title-, library-, media-, and action-specific authorization.");
    if ((context.receipts || []).some((receipt) => receipt.authorizationId === auth.id && receipt.outcome === "success")) {
      return complete("CIRCULATION_ALREADY_COMPLETED", "A stored receipt proves this exact authorization already completed.");
    }
    if ((snapshot.controls || []).some((control) => exact(control.label, SIGN_IN))) {
      return pause(STATES.SIGN_IN, "CIRCULATION_SIGN_IN_REQUIRED", "Libby requires the user to sign in; no circulation control will be clicked.");
    }
    if (snapshot.circulationSuccess === auth.action) {
      return complete(auth.action === "borrow" ? "BORROW_CONFIRMED" : "HOLD_CONFIRMED", "Libby visibly confirms the authorized circulation action.");
    }
    const allowed = auth.action === "borrow" ? /^(borrow|borrow!)$/i : /^(place hold|place a hold|hold)$/i;
    const eligible = (snapshot.controls || []).filter((control) => safeControl(control) && exact(control.label, allowed));
    if (eligible.length > 1) return pause(STATES.AMBIGUOUS, "AMBIGUOUS_CIRCULATION_CONTROL", "Multiple controls match the authorized action.");
    if (!eligible.length) {
      return (context.elapsedMs || 0) > 15000
        ? pause(STATES.FAILED, "CIRCULATION_CONTROL_NOT_FOUND", "The one authorized action did not appear before the timeout.")
        : wait(STATES.CIRCULATE, "WAIT_AUTHORIZED_CONTROL", "Waiting for the exact authorized action control.");
    }
    const steps = context.clickedSteps || [];
    const step = steps.includes("circulation-primary") ? "circulation-confirm" : "circulation-primary";
    if (steps.includes(step)) {
      return (context.elapsedMs || 0) > 15000
        ? pause(STATES.FAILED, "CIRCULATION_UNCONFIRMED", "The authorized click was sent once but Libby did not confirm success.")
        : wait(STATES.CONFIRM_CIRCULATION, "WAIT_CIRCULATION_CONFIRMATION", "Waiting for Libby to confirm the one-shot circulation action.");
    }
    if (step === "circulation-confirm" && !eligible[0].inDialog) {
      return pause(STATES.AMBIGUOUS, "CONFIRMATION_NOT_IN_DIALOG", "A second circulation click is allowed only on an exact control inside a confirmation dialog.");
    }
    return click(step === "circulation-primary" ? STATES.CIRCULATE : STATES.CONFIRM_CIRCULATION, step, eligible[0], step === "circulation-primary" ? "CLICK_AUTHORIZED_ACTION" : "CONFIRM_AUTHORIZED_ACTION", `Click the single exact ${auth.action} control authorized for this media and library.`);
  }

  function isForbiddenLabel(label) { return FORBIDDEN_ACTION.test(String(label || "").trim()); }
  return { STATES, decideImport, decideCirculation, validateAuthorization, isForbiddenLabel };
});
