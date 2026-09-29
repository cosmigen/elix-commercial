import { DragSession } from "./dragSession";

class FolderDropEngine {
  private target: HTMLElement | null = null;

  targetIntent(target: HTMLElement | null, mode: "create" | "absorb" = "absorb") {
    if (this.target === target && target?.dataset.folderDropMode === mode) return;
    this.clearTarget();
    this.target = target;
    if (!target) return;
    target.dataset.folderDropMode = mode;
    target.classList.add("is-folder-formation-target");
  }

  clearTarget() {
    if (!this.target) return;
    this.target.classList.remove("is-folder-formation-target");
    delete this.target.dataset.folderDropMode;
    this.target = null;
  }

  async absorb(session: DragSession, target: HTMLElement, commit: () => void) {
    this.targetIntent(target, target.matches("[data-home-app], [data-start-app], .app-button") ? "create" : "absorb");
    await session.settleTo(target, commit, { absorb: true, duration: 250 });
    this.clearTarget();
  }
}

export const folderDropEngine = new FolderDropEngine();

