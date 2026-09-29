import { collectInteractionTargets, emptyDropIntent } from "../interactions/dropResolver";
import { ItemInteractionEngine } from "../interactions/itemInteractionEngine";

interface FolderDragOptions {
  pointerId: number;
  startX: number;
  startY: number;
  sourceId: string;
  sourceElement: HTMLElement;
  root: HTMLElement;
  onDrop(targetId: string | null): void;
}

class FolderDragSessionManager {
  private readonly engine = new ItemInteractionEngine();
  private targetElement: HTMLElement | null = null;

  begin(options: FolderDragOptions): boolean {
    options.sourceElement.classList.add("is-pointer-grabbed");
    const started = this.engine.begin({
      sourceId: options.sourceId,
      sourceKind: "app",
      surface: "folder",
      pointerId: options.pointerId,
      startX: options.startX,
      startY: options.startY,
      sourceElement: options.sourceElement,
      threshold: 5,
      collectTargets: () => collectInteractionTargets(
        options.root,
        ".app-folder-app[data-folder-app-id]",
        (element) => element.dataset.folderAppId ? { id: element.dataset.folderAppId, kind: "app" } : null
      ).filter((target) => target.id !== options.sourceId),
      resolveIntent: (targets, point) => {
        let nearest = null as typeof targets[number] | null;
        let distance = Number.POSITIVE_INFINITY;
        for (const target of targets) {
          const cx = target.rect.left + target.rect.width / 2;
          const cy = target.rect.top + target.rect.height / 2;
          const inside = point.x >= target.rect.left && point.x <= target.rect.right
            && point.y >= target.rect.top && point.y <= target.rect.bottom;
          const nextDistance = inside ? 0 : (cx - point.x) ** 2 + (cy - point.y) ** 2;
          if (nextDistance < distance) { nearest = target; distance = nextDistance; }
        }
        if (!nearest || distance > 120 ** 2) return emptyDropIntent();
        return { targetId: nearest.id, targetKind: "app", zone: "center", targetElement: nearest.element };
      },
      onIntent: (intent) => {
        options.sourceElement.classList.add("is-pointer-dragging");
        this.targetElement?.classList.remove("is-pointer-target");
        this.targetElement = intent.targetElement;
        this.targetElement?.classList.add("is-pointer-target");
      },
      resolveDrop: (intent) => {
        const target = intent.targetElement;
        const commit = () => {
          if (intent.targetId) options.onDrop(intent.targetId);
          this.cleanup(options.sourceElement);
        };
        return target
          ? { effect: "move", target, commit }
          : { effect: "cancel", commit: () => this.cleanup(options.sourceElement) };
      },
      onCancel: () => this.cleanup(options.sourceElement)
    });
    if (!started) this.cleanup(options.sourceElement);
    return started;
  }

  private cleanup(source: HTMLElement) {
    source.classList.remove("is-pointer-grabbed", "is-pointer-dragging");
    this.targetElement?.classList.remove("is-pointer-target");
    this.targetElement = null;
  }
}

export const folderDragSessionManager = new FolderDragSessionManager();

