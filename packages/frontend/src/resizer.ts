// resizer.ts — the draggable seam between the sidebar and the diff pane.
//
// Lived at the foot of shell.ts, whose own note called it "deliberately
// self-contained: initShell() gains one call, and every listener, every scrap of
// drag state and the whole persistence story live below this line". That was
// true, and it is now enforced by a module boundary rather than asserted by a
// comment — this file shares nothing with the shell's state, and shell.ts still
// gains exactly one call.

const SIDEBAR_WIDTH_KEY = 'ccd.sidebarWidth';
const WIDTH_PROP = '--ccd-sidebar-w';
const WIDTH_MIN_PROP = '--ccd-sidebar-w-min';
const WIDTH_MAX_PROP = '--ccd-sidebar-w-max';

/**
 * Makes `handleEl` drag the sidebar's grid track width, by writing the
 * `--ccd-sidebar-w` custom property on `rootEl`. Also restores the last width
 * from localStorage and resets to the stylesheet default on double-click.
 */
export function initResizer(rootEl: HTMLElement, handleEl: HTMLElement): void {
  // The clamp bounds are declared once, in index.html's :root, and read back
  // here instead of being retyped — otherwise "let the sidebar go wider" is a
  // two-file edit whose half-done version fails silently. If the tokens ever
  // go missing the resizer bows out rather than clamping against NaN, which
  // would collapse the sidebar on the first drag.
  const min = readPx(rootEl, WIDTH_MIN_PROP);
  const max = readPx(rootEl, WIDTH_MAX_PROP);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    console.warn(`[ccd] sidebar resize disabled: ${WIDTH_MIN_PROP}/${WIDTH_MAX_PROP} missing`);
    return;
  }

  // NaN means "never set" — the stylesheet default is in force, and there is
  // nothing worth persisting on release.
  let widthPx = NaN;

  const setWidth = (px: number): void => {
    widthPx = Math.round(Math.min(max, Math.max(min, px)));
    rootEl.style.setProperty(WIDTH_PROP, `${widthPx}px`);
  };

  // Clamp on read too: a width stored on a 4K monitor is absurd on a laptop,
  // and localStorage is user-editable, so a stored value is untrusted input
  // that must not be able to produce a sidebar that eats the diff pane.
  const stored = readStoredWidth();
  if (stored !== null) setWidth(stored);

  let dragging = false;
  // Distance from the pointer to the sidebar's right edge at the moment of
  // grab. Without it the sidebar snaps so that its edge lands under the
  // cursor, jumping by wherever inside the 6px seam you happened to click.
  let grabOffset = 0;

  handleEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    const current = readPx(rootEl, WIDTH_PROP);
    grabOffset = Number.isFinite(current)
      ? e.clientX - rootEl.getBoundingClientRect().left - current
      : 0;
    // Pointer capture rather than the usual document-level mousemove/mouseup
    // pair, for three reasons that each bite in this specific spot:
    //   1. there are no document listeners to add and then leak;
    //   2. the drag cannot be lost if the pointer leaves the window — the
    //      release still arrives here as pointerup/lostpointercapture;
    //   3. Monaco fills the pane you drag *toward* and handles mouse moves
    //      aggressively; capture routes every move to us regardless.
    // Note there is no preventDefault(): it would suppress the compatibility
    // mouse events the dblclick reset below is built from. Text selection is
    // instead killed by the body class, which is set before the compat
    // mousedown fires.
    handleEl.setPointerCapture(e.pointerId);
    dragging = true;
    document.body.classList.add('ccd-resizing');
  });

  handleEl.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    // Relative to #app's left edge, not the viewport's: clientX is
    // viewport-relative and #app is not promised to start at x=0.
    setWidth(e.clientX - rootEl.getBoundingClientRect().left - grabOffset);
    // No diffEditor.layout() call here, and that is not an oversight: diff.ts
    // creates the editor with automaticLayout: true, which Monaco backs with a
    // ResizeObserver (elementSizeObserver.js), so the pane resize re-lays it
    // out by itself. A manual layout() per pointermove would only add a
    // second, synchronous relayout per frame.
  });

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ccd-resizing');
    // On release only. A drag is a hundred-odd pointermoves and every
    // localStorage write is synchronous and hits disk.
    if (Number.isFinite(widthPx)) writeStoredWidth(widthPx);
  };

  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('lostpointercapture', endDrag);

  handleEl.addEventListener('dblclick', () => {
    // Dropping the inline property hands the width back to :root's
    // --ccd-sidebar-w, so "the default" stays defined in exactly one place.
    rootEl.style.removeProperty(WIDTH_PROP);
    widthPx = NaN;
    clearStoredWidth();
  });
}

/** Numeric value of a `--custom: <n>px` property as it applies to `el`. */
function readPx(el: HTMLElement, prop: string): number {
  return parseFloat(getComputedStyle(el).getPropertyValue(prop));
}

// localStorage is guarded on every access, not just on parse. In some privacy
// modes the *property access itself* throws a SecurityError, so an unguarded
// read at boot would take the whole app down. A remembered sidebar width is a
// convenience; it never gets to be the reason the app fails to start.

/** Last persisted width, or null if absent, unreadable or not a number. */
function readStoredWidth(): number | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return null;
    // Number('') and Number('   ') are 0, not NaN, so a blank entry would
    // otherwise read as a valid width and clamp to the minimum. Corrupt
    // storage should fall back to the stylesheet default, not to 220px.
    if (raw.trim() === '') return null;
    const px = Number(raw);
    return Number.isFinite(px) ? px : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
  } catch {
    /* quota or blocked storage: the width just won't survive the reload */
  }
}

function clearStoredWidth(): void {
  try {
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  } catch {
    /* see above */
  }
}
