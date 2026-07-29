// The shell all three dialogs share: a backdrop, a labelled panel, and the two
// ways out of it. Nothing about what goes inside.
//
// This is deliberately NOT a palette. branchpalette.ts's closing note argues at
// length against a generic palette taking row renderers, a search projection,
// group predicates and footer slots, and that argument is right — the rows are
// different shapes, the searches match different fields, and choosing means
// different things. None of that is here. What is here is strictly less than
// even that note concedes is shared: the active index, the clamp and the
// scroll-into-view stay in each palette, because sharing them would need this
// module to know about `visible.length` and to call back into a renderer, which
// is the first step onto exactly the slope the note describes.
//
// What justifies extracting even this much is that the three copies had already
// drifted: two captured Escape and consumed it, the third bubbled and did not.
// One rule written three times is a rule that will be three different rules.

export interface ModalOptions {
  /** Accessible name for `role=dialog` — 'Select commits', 'Open repository'. */
  label: string;
  /**
   * One extra class beside `ccd-modal`. The two palettes pass 'ccd-palette',
   * which index.html defines as a `.ccd-modal` variant; the repo picker passes
   * nothing and gets the plain panel.
   */
  variant?: string;
  /**
   * Every key EXCEPT Escape, in the capture phase, for as long as the modal is
   * open. Escape is handled here; everything else is handed over exactly as it
   * arrived, which is what keeps each palette's own arrow/Enter/Space model in
   * its own file rather than in a shared key table here.
   */
  onKeyDown?(event: KeyboardEvent): void;
}

export interface Modal {
  /**
   * The panel. Append the dialog's structure to this.
   *
   * Content may be rendered before or after `open()`, but a palette that scrolls
   * its active row into view must do it after: `scrollIntoView()` on a detached
   * element is a silent no-op, and that scroll is how a palette opens on the
   * current selection rather than at the top of the list.
   */
  readonly panel: HTMLElement;
  /** Mounts the modal and starts listening for Escape. */
  open(): void;
  /** Unmounts it and releases the listener. Safe to call twice. */
  close(): void;
}

export function createModal({ label, variant, onKeyDown }: ModalOptions): Modal {
  const backdrop = document.createElement('div');
  backdrop.className = 'ccd-modal-backdrop';

  const panel = document.createElement('div');
  panel.className = variant ? `ccd-modal ${variant}` : 'ccd-modal';
  panel.role = 'dialog';
  panel.ariaModal = 'true';
  panel.ariaLabel = label;

  backdrop.append(panel);

  // Click-outside and Escape both close, because a modal that can only be
  // dismissed by finding its Cancel button is a trap on a narrow window.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  // Captured on the document rather than bound to the panel, so the keys work
  // wherever focus happens to be — and in the capture phase so Escape reaches
  // this before anything below it in the page treats it as its own. Monaco
  // binds Escape on its own DOM node, which is what makes the phase matter
  // rather than being a preference.
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    onKeyDown?.(e);
  }

  function open(): void {
    document.addEventListener('keydown', handleKeyDown, true);
    document.body.append(backdrop);
  }

  function close(): void {
    document.removeEventListener('keydown', handleKeyDown, true);
    backdrop.remove();
  }

  return { panel, open, close };
}
