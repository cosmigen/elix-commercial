export const ELIX_DRAG_THRESHOLD = 5;

export function crossedPointerThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold = ELIX_DRAG_THRESHOLD
): boolean {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return dx * dx + dy * dy >= threshold * threshold;
}

export function isInteractiveGestureTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(
    "button,input,select,textarea,a,[contenteditable='true'],[role='slider'],[data-no-surface-drag='true']"
  ));
}
