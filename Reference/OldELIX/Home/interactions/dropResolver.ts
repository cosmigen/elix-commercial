import type { InteractionDropIntent, InteractionPoint, InteractionTarget } from "./types";

export const emptyDropIntent = (): InteractionDropIntent => ({
  targetId: null,
  targetKind: null,
  zone: null,
  targetElement: null
});

export const sameDropIntent = (left: InteractionDropIntent, right: InteractionDropIntent) =>
  left.targetId === right.targetId && left.targetKind === right.targetKind && left.zone === right.zone;

export function resolveSegmentedDropIntent(
  targets: InteractionTarget[],
  sourceId: string,
  point: InteractionPoint,
  sourceKind: "app" | "folder" = "app"
): InteractionDropIntent {
  const target = targets.find((candidate) =>
    candidate.id !== sourceId
    && point.x >= candidate.rect.left
    && point.x <= candidate.rect.right
    && point.y >= candidate.rect.top
    && point.y <= candidate.rect.bottom
  );
  if (!target) return emptyDropIntent();
  const ratio = (point.x - target.rect.left) / Math.max(1, target.rect.width);
  if (target.kind === "folder") {
    const zone = sourceKind === "folder" ? (ratio < .5 ? "before" : "after") : "center";
    return { targetId: target.id, targetKind: target.kind, zone, targetElement: target.element };
  }
  const zone = ratio < .28 ? "before" : ratio > .72 ? "after" : "center";
  return { targetId: target.id, targetKind: target.kind, zone, targetElement: target.element };
}

export function collectInteractionTargets(
  root: ParentNode,
  selector: string,
  identity: (element: HTMLElement) => { id: string; kind: "app" | "folder" } | null
): InteractionTarget[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
    const value = identity(element);
    return value ? [{ ...value, element, rect: element.getBoundingClientRect() }] : [];
  });
}

