// topbar.ts — the header strip: a breadcrumb of what is being reviewed on the
// left, and how it is rendered on the right.
//
// It knows nothing about repositories, branches or commits, and that is the
// point of the interface being `setCrumbs(Crumb[])`. A crumb is a label, a
// tooltip and a click handler; deciding that the second one names a branch is
// shell.ts's business, because shell.ts is what holds the state a crumb
// describes. Adding a fourth thing to the breadcrumb later is one more array
// element at the call site, not an edit here.
//
// The split down the middle is what the two halves mean. Everything on the left
// narrows the SUBJECT — which repository, which ref, which commits. Everything
// on the right changes the VIEW of that subject and applies to all of it
// equally. That is the same reasoning the old sidebar toolbar was placed by; it
// reads more clearly as two ends of one bar than as two stacked rows.
//
// The view controls keep reading their state back from diff.ts rather than
// mirroring it here, so a preference restored from localStorage is already
// correct on the first paint and there is no second copy of "which mode are we
// in" to drift from the editor's.

import {
  isCollapseUnchanged,
  isSideBySide,
  setCollapseUnchanged,
  setRenderSideBySide
} from './diff';

/** One step of the breadcrumb: what it says, and what clicking it opens. */
export interface Crumb {
  /**
   * Stable identity for this position in the breadcrumb ('repo', 'branch',
   * 'selection'). Rendering is keyed by it, so a crumb whose label changes on
   * every refresh does not lose focus or its hover state to a rebuild.
   */
  key: string;
  label: string;
  /** The full form — a checkout path, a full refname, the commit subjects. */
  title: string;
  /** Muted glyph before the label. Purely decorative; ariaHidden. */
  icon?: string;
  onClick(): void;
}

export interface TopBar {
  el: HTMLElement;
  setCrumbs(crumbs: Crumb[]): void;
}

/**
 * Builds the header. The caller owns placement and calls `setCrumbs` whenever
 * the thing being reviewed changes.
 */
export function createTopBar(): TopBar {
  const el = document.createElement('header');
  el.className = 'ccd-topbar';

  const trail = document.createElement('nav');
  trail.className = 'ccd-trail';
  trail.ariaLabel = 'Review scope';

  const actions = document.createElement('div');
  actions.className = 'ccd-topbar-actions';
  actions.append(layoutToggle(), collapseToggle());

  el.append(trail, actions);

  // Buttons are reused across renders rather than rebuilt, so a crumb the user
  // is hovering or has tabbed to survives a live refresh landing underneath
  // them. Rebuilding would also close the palette a crumb had just opened.
  const buttons = new Map<string, HTMLButtonElement>();

  function setCrumbs(crumbs: Crumb[]): void {
    const wanted = new Set(crumbs.map((c) => c.key));
    for (const [key, button] of buttons) {
      if (!wanted.has(key)) {
        button.parentElement?.remove();
        buttons.delete(key);
      }
    }

    const rendered: Node[] = [];
    for (const crumb of crumbs) {
      if (rendered.length > 0) rendered.push(separator());
      rendered.push(renderCrumb(crumb));
    }
    trail.replaceChildren(...rendered);
  }

  function renderCrumb(crumb: Crumb): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'ccd-crumb-slot';

    let button = buttons.get(crumb.key);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'ccd-chip';
      buttons.set(crumb.key, button);
    }
    // Reassigned every render: the handler closes over state that has usually
    // moved on since the last one.
    button.onclick = () => crumb.onClick();
    button.title = crumb.title;
    button.dataset.crumb = crumb.key;

    const icon = document.createElement('span');
    icon.className = 'ccd-chip-icon';
    icon.ariaHidden = 'true';
    icon.textContent = crumb.icon ?? '';

    const label = document.createElement('span');
    label.className = 'ccd-chip-label';
    label.textContent = crumb.label;

    button.replaceChildren(icon, label);
    wrapper.append(button);
    return wrapper;
  }

  return { el, setCrumbs };
}

function separator(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'ccd-crumb-sep';
  sep.ariaHidden = 'true';
  sep.textContent = '›';
  return sep;
}

/**
 * Side-by-side / Inline as a two-button segmented control.
 *
 * A segmented control rather than a checkbox because neither layout is the
 * negation of the other in the reader's head — "Inline" unchecked does not say
 * "side-by-side", it says nothing.
 *
 * `aria-pressed` is the only record of which segment is selected: index.html
 * styles the selection off that same attribute, so the button that looks
 * pressed is by construction the one a screen reader is told is pressed.
 */
function layoutToggle(): HTMLElement {
  const group = document.createElement('div');
  group.className = 'ccd-segmented';
  group.role = 'group';
  group.ariaLabel = 'Diff layout';

  const segments = [
    { label: 'Split', sideBySide: true },
    { label: 'Inline', sideBySide: false }
  ].map((spec) => {
    const button = document.createElement('button');
    button.className = 'ccd-segment';
    button.type = 'button';
    button.textContent = spec.label;
    group.append(button);
    return { button, sideBySide: spec.sideBySide };
  });

  const sync = (): void => {
    for (const segment of segments) {
      segment.button.ariaPressed = String(segment.sideBySide === isSideBySide());
    }
  };

  for (const segment of segments) {
    segment.button.addEventListener('click', () => {
      setRenderSideBySide(segment.sideBySide);
      sync();
    });
  }

  sync();
  return group;
}

/**
 * "Collapse unchanged" as a checkbox, deliberately unlike the layout control
 * beside it: this one really is a thing that is either on or off, and its off
 * state has an obvious meaning (show every line).
 *
 * It exists at all as the escape hatch for the cases folding gets wrong — a
 * reader who wants the whole file, or a diff where the collapsed bars land
 * somewhere unhelpful — so it must stay one click away rather than live behind
 * a settings screen this app does not have.
 */
function collapseToggle(): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'ccd-check';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'ccd-checkbox';
  // Read back from diff.ts rather than tracked here, so the restored
  // preference and the control cannot disagree on the first paint.
  box.checked = isCollapseUnchanged();
  box.addEventListener('change', () => setCollapseUnchanged(box.checked));

  const text = document.createElement('span');
  text.textContent = 'Collapse unchanged';

  wrapper.append(box, text);
  return wrapper;
}
