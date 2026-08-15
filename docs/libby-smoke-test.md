# Signed-in Libby smoke-test checklist

Use a non-critical test title and a dedicated temporary tag. Do not test against a loan or hold you are unwilling to create. Record only the sanitized diagnostic shown by LibbySave; never attach cookies, local-storage exports, card numbers, PINs, or full URLs with query strings.

## Setup

- [ ] Load the unpacked extension and confirm the Libby content scripts load without console errors.
- [ ] Sign in to one test library in Libby before beginning.
- [ ] Choose one uniquely titled available item and one uniquely titled unavailable item.
- [ ] Create no tag with the temporary test tag name before the missing-tag test.

## Import state machine

- [ ] Start an import and throttle the network. Confirm the panel stays in `waiting-for-search-results` and makes no click while results are loading.
- [ ] Confirm one exact title/author result opens once after a delayed render.
- [ ] Search a deliberately ambiguous title. Confirm `AMBIGUOUS_TITLE` pauses and no result opens.
- [ ] With an existing exact tag, confirm only that tag is selected.
- [ ] With the temporary tag missing, confirm **New Tag**, the uniquely labelled tag-name input, and **Create** occur as separate transitions.
- [ ] Confirm the queue advances only after the tag is visibly checked or an exact saved status appears.
- [ ] Rerender the dialog after each transition. Confirm no recorded transition clicks twice.
- [ ] Confirm **Borrow**, **Place hold**, **Return**, **Renew**, **Remove hold**, and **Purchase** are never clicked during import.

## Borrow and hold authorization

- [ ] Click **Borrow now** in LibbySave for the available test item. Confirm the authorization panel names the expected title and action.
- [ ] Confirm the exact media ID and library page opens and only exact **Borrow** controls are eligible.
- [ ] If Libby displays a confirmation dialog, confirm one second click occurs only inside that dialog.
- [ ] Confirm the visible success status creates a receipt and replaying page events does not borrow again.
- [ ] Repeat with **Place hold** for the unavailable test item.
- [ ] Wait more than 90 seconds before a test action. Confirm `AUTH_EXPIRED` and no click.
- [ ] Navigate to another title or library after authorization. Confirm `AUTH_PAGE_MISMATCH` and no click.
- [ ] Sign out before authorizing a test action. Confirm `CIRCULATION_SIGN_IN_REQUIRED` and no click.

## Forbidden and ambiguous controls

- [ ] On loans and holds pages, confirm LibbySave never clicks **Return**, **Renew**, **Remove hold**, **Cancel hold**, **Purchase**, or unrelated actions.
- [ ] If two exact eligible controls are visible at once, confirm `AMBIGUOUS_CIRCULATION_CONTROL` pauses.
- [ ] Confirm the diagnostic contains only mode, state, code, explanation, origin/path, opaque operation ID, media ID, library slug, and timestamp.

## Report results

- Extension version/commit:
- Chrome version and OS:
- Library slug:
- Diagnostic JSON:
- Expected state:
- Observed state:
- Screenshot with account/card information removed:
