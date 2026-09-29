import { DragSession } from "./dragSession";
import { emptyDropIntent, sameDropIntent } from "./dropResolver";
import { folderDropEngine } from "./folderDropEngine";
import type {
  InteractionDropIntent,
  InteractionItemKind,
  InteractionPoint,
  InteractionRect,
  InteractionSurface,
  InteractionTarget
} from "./types";

export type ItemDropResolution = {
  effect: "cancel" | "move" | "absorb";
  target?: HTMLElement | InteractionRect | null;
  commit?: () => void;
};

export type ItemInteractionOptions = {
  sourceId: string;
  sourceKind: InteractionItemKind;
  surface: InteractionSurface;
  pointerId: number;
  startX: number;
  startY: number;
  sourceElement: HTMLElement;
  threshold?: number;
  collectTargets(): InteractionTarget[];
  resolveIntent(targets: InteractionTarget[], point: InteractionPoint): InteractionDropIntent;
  onStart?(): void;
  onIntent?(intent: InteractionDropIntent): void;
  resolveDrop(intent: InteractionDropIntent, session: DragSession): ItemDropResolution | Promise<ItemDropResolution>;
  onCancel?(): void;
};

type ActiveInteraction = ItemInteractionOptions & {
  targets: InteractionTarget[];
  pending: InteractionPoint | null;
  frame: number;
  moved: boolean;
  lastIntent: InteractionDropIntent;
  previousDraggable: boolean;
  dragSession: DragSession | null;
};

export class ItemInteractionEngine {
  private active: ActiveInteraction | null = null;

  begin(options: ItemInteractionOptions) {
    if (this.active || options.pointerId < 0) return false;
    this.active = {
      ...options,
      targets: options.collectTargets(),
      pending: null,
      frame: 0,
      moved: false,
      lastIntent: emptyDropIntent(),
      previousDraggable: options.sourceElement.draggable,
      dragSession: null
    };
    options.sourceElement.draggable = false;
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("pointercancel", this.onPointerCancel, true);
    return true;
  }

  cancel() {
    const active = this.active;
    if (!active) return;
    this.detach(active);
    active.onCancel?.();
    void active.dragSession?.cancel();
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    active.pending = { x: event.clientX, y: event.clientY };
    if (!active.frame) active.frame = requestAnimationFrame(this.flush);
  };

  private readonly flush = () => {
    const active = this.active;
    if (!active) return;
    active.frame = 0;
    const point = active.pending;
    active.pending = null;
    if (!point) return;
    const distance = Math.hypot(point.x - active.startX, point.y - active.startY);
    if (!active.moved && distance >= (active.threshold ?? 5)) {
      active.moved = true;
      active.dragSession = new DragSession(
        active.sourceElement,
        { x: active.startX, y: active.startY },
        active.sourceKind,
        active.surface
      ).start();
      // Drag state starts only after the gesture threshold. Mutating Dock
      // layout on pointer-down made ordinary app clicks race a React rerender.
      active.onStart?.();
    }
    if (!active.moved || !active.dragSession) return;
    active.dragSession.move(point.x, point.y);
    const intent = active.resolveIntent(active.targets, point);
    if (!sameDropIntent(intent, active.lastIntent)) {
      active.lastIntent = intent;
      active.onIntent?.(intent);
    }
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    if (active.pending) {
      if (active.frame) cancelAnimationFrame(active.frame);
      this.flush();
    }
    if (active.moved && active.dragSession) {
      const releasePoint = { x: event.clientX, y: event.clientY };
      active.dragSession.move(releasePoint.x, releasePoint.y);
      const releaseIntent = active.resolveIntent(active.targets, releasePoint);
      if (!sameDropIntent(releaseIntent, active.lastIntent)) {
        active.lastIntent = releaseIntent;
        active.onIntent?.(releaseIntent);
      }
    }
    this.detach(active);
    if (!active.moved || !active.dragSession) {
      active.onCancel?.();
      return;
    }
    active.sourceElement.dataset.interactionSuppressClick = "true";
    window.setTimeout(() => delete active.sourceElement.dataset.interactionSuppressClick, 0);
    void this.finishDrop(active);
  };

  private async finishDrop(active: ActiveInteraction) {
    const session = active.dragSession;
    if (!session) return;
    try {
      const resolution = await active.resolveDrop(active.lastIntent, session);
      const commit = resolution.commit ?? (() => {});
      if (resolution.effect === "absorb" && resolution.target instanceof HTMLElement) {
        await folderDropEngine.absorb(session, resolution.target, commit);
      } else if (resolution.effect === "move" && resolution.target) {
        await session.settleTo(resolution.target, commit);
      } else {
        active.onCancel?.();
        await session.cancel();
      }
    } catch {
      active.onCancel?.();
      await session.cancel();
    }
  }

  private readonly onPointerCancel = (event: PointerEvent) => {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    this.detach(active);
    active.onCancel?.();
    void active.dragSession?.cancel();
  };

  private detach(active: ActiveInteraction) {
    if (active.frame) cancelAnimationFrame(active.frame);
    active.sourceElement.draggable = active.previousDraggable;
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("pointercancel", this.onPointerCancel, true);
    if (this.active === active) this.active = null;
  }
}
