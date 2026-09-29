import { prefersReducedElixMotion } from "../motion/elixMotion";
import type { InteractionItemKind, InteractionRect, InteractionSurface } from "./types";

const prefersReducedMotion = prefersReducedElixMotion;

const rectValue = (rect: InteractionRect) => ({
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height
});

export class DragSession {
  readonly sourceRect: ReturnType<typeof rectValue>;
  private readonly offsetX: number;
  private readonly offsetY: number;
  private proxy: HTMLElement | null = null;
  private left: number;
  private top: number;
  private scale = 1.02;
  private completed = false;

  constructor(
    readonly sourceElement: HTMLElement,
    pointer: { x: number; y: number },
    readonly itemKind: InteractionItemKind,
    readonly surface: InteractionSurface
  ) {
    // Dock buttons may already be magnified when a drag begins. The persistent
    // slot owns stable layout geometry, so use it for the portal proxy instead
    // of cloning the transient transformed button bounds.
    const stableSource = surface === "dock"
      ? sourceElement.closest<HTMLElement>(".dock-app-slot") ?? sourceElement
      : sourceElement;
    this.sourceRect = rectValue(stableSource.getBoundingClientRect());
    this.offsetX = pointer.x - this.sourceRect.left;
    this.offsetY = pointer.y - this.sourceRect.top;
    this.left = this.sourceRect.left;
    this.top = this.sourceRect.top;
  }

  start() {
    if (this.proxy || this.completed) return this;
    const proxy = document.createElement("div");
    proxy.className = "elix-item-drag-proxy";
    proxy.dataset.itemKind = this.itemKind;
    proxy.dataset.surface = this.surface;
    proxy.setAttribute("aria-hidden", "true");
    Object.assign(proxy.style, {
      width: `${this.sourceRect.width}px`,
      height: `${this.sourceRect.height}px`,
      transform: `translate3d(${this.left}px, ${this.top}px, 0) scale(${this.scale})`
    });

    const visual = this.sourceElement.cloneNode(true) as HTMLElement;
    visual.removeAttribute("id");
    visual.removeAttribute("draggable");
    visual.removeAttribute("aria-label");
    visual.classList.remove(
      "selected", "is-dragging", "is-moving", "is-grabbed", "is-drag-armed",
      "dock-pointer-grabbed", "dock-pointer-dragging", "is-pointer-grabbed", "is-pointer-dragging"
    );
    visual.classList.add("elix-item-drag-visual");
    Object.assign(visual.style, {
      position: "relative",
      inset: "auto",
      left: "auto",
      top: "auto",
      width: "100%",
      height: "100%",
      margin: "0",
      transform: "none",
      opacity: "1",
      pointerEvents: "none"
    });
    proxy.append(visual);
    document.body.append(proxy);
    this.proxy = proxy;
    this.sourceElement.classList.add("elix-item-drag-source");
    this.sourceElement.dataset.interactionGrabbed = "true";
    return this;
  }

  move(pointerX: number, pointerY: number, scale = 1.02) {
    if (!this.proxy || this.completed) return;
    this.left = pointerX - this.offsetX;
    this.top = pointerY - this.offsetY;
    this.scale = scale;
    this.proxy.style.transform = `translate3d(${this.left}px, ${this.top}px, 0) scale(${scale})`;
  }

  async settleTo(
    target: InteractionRect | HTMLElement,
    commit: () => void,
    options: { absorb?: boolean; duration?: number; targetPulse?: boolean } = {}
  ) {
    if (this.completed) return;
    this.completed = true;
    const targetRect = rectValue(target instanceof HTMLElement ? target.getBoundingClientRect() : target);
    const proxy = this.proxy;
    const runCommit = this.once(commit);
    if (!proxy || prefersReducedMotion()) {
      runCommit();
      this.destroy();
      return;
    }

    const absorb = options.absorb === true;
    const endScale = absorb ? .12 : 1;
    const endLeft = absorb
      ? targetRect.left + targetRect.width / 2 - this.sourceRect.width * endScale / 2
      : targetRect.left;
    const endTop = absorb
      ? targetRect.top + targetRect.height / 2 - this.sourceRect.height * endScale / 2
      : targetRect.top;
    const duration = options.duration ?? (absorb ? 250 : 190);
    const targetElement = target instanceof HTMLElement ? target : null;
    let pulse: Animation | null = null;
    if (targetElement && options.targetPulse !== false) {
      pulse = targetElement.animate(
        absorb
          ? [
              { transform: "translate3d(0,0,0) scale(1)" },
              { transform: "translate3d(0,0,0) scale(1.14)", offset: .5 },
              { transform: "translate3d(0,0,0) scale(.96)", offset: .78 },
              { transform: "translate3d(0,0,0) scale(1)" }
            ]
          : [
              { transform: "translate3d(0,0,0) scale(.985)" },
              { transform: "translate3d(0,0,0) scale(1.015)" },
              { transform: "translate3d(0,0,0) scale(1)" }
            ],
        { duration: duration + 30, easing: "cubic-bezier(.2,.84,.26,1)" }
      );
      pulse.id = absorb ? "elix-folder-target-settle" : "elix-item-target-settle";
    }
    const motion = proxy.animate(
      [
        { opacity: 1, transform: proxy.style.transform },
        absorb
          ? { opacity: .82, transform: `translate3d(${this.left + (endLeft - this.left) * .62}px, ${this.top + (endTop - this.top) * .62}px, 0) scale(.58)`, offset: .62 }
          : { opacity: 1, transform: `translate3d(${endLeft}px, ${endTop}px, 0) scale(1.015)`, offset: .78 },
        { opacity: absorb ? 0 : 1, transform: `translate3d(${endLeft}px, ${endTop}px, 0) scale(${endScale})` }
      ],
      { duration, easing: absorb ? "cubic-bezier(.28,0,.3,1)" : "cubic-bezier(.2,.84,.26,1)", fill: "forwards" }
    );
    motion.id = absorb ? "elix-item-folder-absorb" : "elix-item-drop-settle";
    await motion.finished.catch(() => undefined);
    runCommit();
    await pulse?.finished.catch(() => undefined);
    this.destroy();
  }

  async cancel(commit?: () => void) {
    await this.settleTo(this.sourceRect, commit ?? (() => {}), { duration: 160, targetPulse: false });
  }

  destroy() {
    this.proxy?.remove();
    this.proxy = null;
    this.sourceElement.classList.remove("elix-item-drag-source");
    delete this.sourceElement.dataset.interactionGrabbed;
  }

  private once(commit: () => void) {
    let invoked = false;
    return () => {
      if (invoked) return;
      invoked = true;
      commit();
    };
  }
}
