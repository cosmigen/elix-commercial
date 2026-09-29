export type InteractionItemKind = "app" | "folder" | "widget";
export type InteractionSurface = "desktop" | "dock" | "start" | "folder";
export type InteractionDropZone = "before" | "center" | "after";

export type InteractionPoint = { x: number; y: number };

export type InteractionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
};

export type InteractionTarget = {
  id: string;
  kind: "app" | "folder";
  element: HTMLElement;
  rect: DOMRect;
};

export type InteractionDropIntent = {
  targetId: string | null;
  targetKind: "app" | "folder" | null;
  zone: InteractionDropZone | null;
  targetElement: HTMLElement | null;
};

