class ContextMenuService {
  private currentId: symbol | null = null;
  private closeCurrent: (() => void) | null = null;
  private previousFocus: HTMLElement | null = null;

  begin(close: () => void): symbol {
    // Capture the original caller *before* replacing an existing menu. Otherwise
    // the new menu could restore focus to a detached button from the old menu.
    const inheritedFocus = this.previousFocus?.isConnected
      ? this.previousFocus
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorClose = this.closeCurrent;
    priorClose?.();
    const id = Symbol("context-menu");
    this.currentId = id;
    this.closeCurrent = close;
    this.previousFocus = inheritedFocus;
    return id;
  }

  end(id: symbol, restoreFocus = true): void {
    if (this.currentId !== id) return;
    const focus = this.previousFocus;
    this.currentId = null;
    this.closeCurrent = null;
    this.previousFocus = null;
    if (restoreFocus && focus?.isConnected) queueMicrotask(() => focus.focus({ preventScroll: true }));
  }
}

export const contextMenuService = new ContextMenuService();
