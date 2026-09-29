/** Shared interaction contracts and framework-neutral CSS primitives. */

import type {
  UiInteractionMetrics,
  UiKeyAction,
  UiPrimitiveContract,
  UiPrimitiveKind,
} from './types.ts'

/** Pointer/touch timing and sizing defaults shared by shell surfaces. */
export const UI_INTERACTION_METRICS: UiInteractionMetrics = Object.freeze({
  minimumHitTargetPx: 40,
  largeHitTargetPx: 48,
  dragThresholdPx: 6,
  hoverDelayMs: 350,
  submenuOpenDelayMs: 180,
  submenuCloseDelayMs: 300,
})

const CONTRACTS: readonly UiPrimitiveContract[] = [
  { kind: 'button', role: 'button', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: ['Enter', ' '], navigationKeys: [] },
  { kind: 'toggle', role: 'switch', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: ['Enter', ' '], navigationKeys: [] },
  { kind: 'slider', role: 'slider', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: [], navigationKeys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] },
  { kind: 'segmented', role: 'radiogroup', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: ['Enter', ' '], navigationKeys: ['ArrowLeft', 'ArrowRight', 'Home', 'End'] },
  { kind: 'menu', role: 'menu', focusable: true, restoresFocus: true, escapeDismisses: true, outsideClickDismisses: true, activationKeys: ['Enter', ' '], navigationKeys: ['ArrowUp', 'ArrowDown', 'Home', 'End'] },
  { kind: 'submenu', role: 'menu', focusable: true, restoresFocus: true, escapeDismisses: true, outsideClickDismisses: true, activationKeys: ['Enter', ' ', 'ArrowRight'], navigationKeys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'Home', 'End'] },
  { kind: 'context-menu', role: 'menu', focusable: true, restoresFocus: true, escapeDismisses: true, outsideClickDismisses: true, activationKeys: ['Enter', ' '], navigationKeys: ['ArrowUp', 'ArrowDown', 'Home', 'End'] },
  { kind: 'tooltip', role: 'tooltip', focusable: false, restoresFocus: false, escapeDismisses: true, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'popover', role: 'dialog', focusable: true, restoresFocus: true, escapeDismisses: true, outsideClickDismisses: true, activationKeys: [], navigationKeys: [] },
  { kind: 'sheet', role: 'dialog', focusable: true, restoresFocus: true, escapeDismisses: true, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'dialog', role: 'dialog', focusable: true, restoresFocus: true, escapeDismisses: true, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'search', role: 'searchbox', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: ['Enter'], navigationKeys: ['ArrowUp', 'ArrowDown'] },
  { kind: 'list', role: 'listbox', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: ['Enter', ' '], navigationKeys: ['ArrowUp', 'ArrowDown', 'Home', 'End'] },
  { kind: 'tabs', role: 'tablist', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: ['Enter', ' '], navigationKeys: ['ArrowLeft', 'ArrowRight', 'Home', 'End'] },
  { kind: 'toast', role: 'status', focusable: false, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'empty', role: 'status', focusable: false, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'loading', role: 'status', focusable: false, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'error', role: 'alert', focusable: false, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'progress', role: 'progressbar', focusable: false, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: [], navigationKeys: [] },
  { kind: 'cancel', role: 'button', focusable: true, restoresFocus: false, escapeDismisses: false, outsideClickDismisses: false, activationKeys: ['Enter', ' '], navigationKeys: [] },
]

/** Complete primitive interaction inventory. */
export const UI_PRIMITIVE_CONTRACTS: Readonly<Record<UiPrimitiveKind, UiPrimitiveContract>> = Object.freeze(
  Object.fromEntries(CONTRACTS.map(contract => [contract.kind, Object.freeze(contract)])) as Record<UiPrimitiveKind, UiPrimitiveContract>,
)

/** Retrieve the interaction contract for one shared primitive. */
export function getUiPrimitiveContract(kind: UiPrimitiveKind): UiPrimitiveContract {
  return UI_PRIMITIVE_CONTRACTS[kind]
}

/** Convert one key press into a framework-neutral primitive action. */
export function resolvePrimitiveKeyAction(kind: UiPrimitiveKind, key: string): UiKeyAction {
  const contract = getUiPrimitiveContract(kind)
  if (key === 'Escape' && contract.escapeDismisses) return 'dismiss'
  if (contract.activationKeys.includes(key)) return 'activate'
  if (key === 'Home' && contract.navigationKeys.includes(key)) return 'first'
  if (key === 'End' && contract.navigationKeys.includes(key)) return 'last'
  if ((key === 'ArrowLeft' || key === 'ArrowUp') && contract.navigationKeys.includes(key)) return 'previous'
  if ((key === 'ArrowRight' || key === 'ArrowDown') && contract.navigationKeys.includes(key)) return 'next'
  return 'none'
}

/** Resolve a roving-focus index without allowing focus to escape the collection. */
export function resolveRovingFocusIndex(current: number, itemCount: number, action: UiKeyAction): number {
  if (itemCount <= 0) return -1
  const normalized = Math.min(Math.max(current, 0), itemCount - 1)
  switch (action) {
    case 'first': return 0
    case 'last': return itemCount - 1
    case 'previous': return (normalized - 1 + itemCount) % itemCount
    case 'next': return (normalized + 1) % itemCount
    default: return normalized
  }
}

/** Framework-neutral baseline CSS for shell controls and accessibility behavior. */
export function generateUiFoundationCss(): string {
  return `
:root {
  font-family: var(--elix-font-ui);
  font-size: calc(16px * var(--elix-text-scale, 1));
  color: var(--elix-text-primary);
  color-scheme: var(--elix-color-scheme, dark);
}
*, *::before, *::after { box-sizing: border-box; }
:focus-visible { outline: var(--elix-focus-ring-width) solid var(--elix-focus-ring); outline-offset: 2px; }
.elix-control {
  min-height: var(--elix-hit-target);
  font: inherit;
  color: var(--elix-text-primary);
  background: var(--elix-surface-glass);
  border: 1px solid var(--elix-surface-border);
  border-radius: var(--elix-radius-md);
  transition: background var(--elix-motion-fast) var(--elix-ease-standard), transform var(--elix-motion-fast) var(--elix-ease-standard);
}
.elix-control:not(:disabled):hover { background: var(--elix-surface-glass-hover); }
.elix-control:disabled, .elix-control[aria-disabled="true"] { color: var(--elix-disabled); cursor: not-allowed; opacity: .72; }
.elix-button { padding: calc(var(--elix-space-2) * var(--elix-density-scale)) calc(var(--elix-space-4) * var(--elix-density-scale)); cursor: pointer; }
.elix-toggle { display: inline-flex; align-items: center; gap: var(--elix-space-2); padding: var(--elix-space-2); }
.elix-slider { accent-color: var(--elix-accent); min-height: var(--elix-hit-target); }
.elix-segmented { display: inline-flex; gap: 2px; padding: 2px; background: var(--elix-surface-glass); border-radius: var(--elix-radius-lg); }
.elix-menu, .elix-popover, .elix-dialog, .elix-sheet, .elix-toast {
  color: var(--elix-text-primary); background: var(--elix-surface-glass-heavy); border: 1px solid var(--elix-surface-border); box-shadow: var(--elix-surface-shadow-md);
}
.elix-menu { padding: var(--elix-space-1); border-radius: var(--elix-radius-md); }
.elix-menuitem { min-height: var(--elix-hit-target); display: flex; align-items: center; padding: 0 var(--elix-space-3); border-radius: var(--elix-radius-sm); }
.elix-menuitem[aria-selected="true"], .elix-menuitem:hover { background: var(--elix-selection-background); }
.elix-dialog, .elix-sheet, .elix-popover { border-radius: var(--elix-radius-xl); padding: var(--elix-space-4); }
.elix-search { min-height: var(--elix-hit-target); color: var(--elix-text-primary); background: var(--elix-surface-glass); border: 1px solid var(--elix-surface-border); border-radius: var(--elix-radius-md); padding: 0 var(--elix-space-3); }
.elix-list { margin: 0; padding: 0; list-style: none; }
.elix-listitem { min-height: var(--elix-hit-target); display: flex; align-items: center; padding: 0 var(--elix-space-3); }
.elix-tabs { display: flex; gap: var(--elix-space-1); overflow-x: auto; border-bottom: 1px solid var(--elix-divider); }
.elix-tab { min-height: var(--elix-hit-target); flex: 0 0 auto; white-space: nowrap; overflow-wrap: normal; }
.elix-tab[aria-selected="true"] { color: var(--elix-accent); border-bottom: 2px solid var(--elix-accent); }
.elix-toast { border-radius: var(--elix-radius-lg); padding: var(--elix-space-3) var(--elix-space-4); }
.elix-error { color: var(--elix-danger); }
.elix-success { color: var(--elix-success); }
.elix-muted { color: var(--elix-text-muted); }
.elix-progress { accent-color: var(--elix-accent); }
[data-elix-reduce-motion="true"] *, [data-elix-reduce-motion="true"] *::before, [data-elix-reduce-motion="true"] *::after { animation-duration: 0ms !important; transition-duration: 0ms !important; scroll-behavior: auto !important; }
@media (forced-colors: active) { .elix-control, .elix-menu, .elix-popover, .elix-dialog, .elix-sheet { forced-color-adjust: auto; } }
`.trim()
}
