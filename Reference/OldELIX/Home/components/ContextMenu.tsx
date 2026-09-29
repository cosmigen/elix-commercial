import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronRight } from "../icons";
import { positionPointPopup, positionPopup } from "../managers/popupPositioner";
import { contextMenuService } from "../managers/contextMenuService";
import { elixMotion, playElixMotion, prefersReducedElixMotion } from "../motion/elixMotion";
import { runtimeConfig } from "../runtimeConfig";
// Pure DOM ContextMenu migration adapter - legacy surface references excluded

export type ContextMenuAction = {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  shortcut?: string;
  children?: ContextMenuAction[];
  separatorBefore?: boolean;
  onSelect?(): void;
};

export type ContextMenuProps = {
  x: number;
  y: number;
  label: string;
  actions: ContextMenuAction[];
  onClose(): void;
  width?: number;
};


function ContextSubmenu({ anchor, label, actions, close, back }: {
  anchor: HTMLElement;
  label: string;
  actions: ContextMenuAction[];
  close(): void;
  back(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const next = positionPopup({ anchor: anchor.getBoundingClientRect(), popupWidth: bounds.width, popupHeight: bounds.height, preferred: "right", gap: 4 });
    setPosition({ x: next.x, y: next.y });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [anchor, actions.length]);
  return createPortal(
    <div ref={ref} className="elix-context-menu elix-context-submenu" role="menu" aria-label={label} style={{ left: position.x, top: position.y, width: 252 }} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
      if (event.key === "ArrowLeft") { event.preventDefault(); back(); anchor.focus(); return; }
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      const next = event.key === "ArrowDown" ? (current + 1) % buttons.length
        : event.key === "ArrowUp" ? (current - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0
        : event.key === "End" ? buttons.length - 1
        : -1;
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
    }}>
      {actions.map((action) => <div className={action.separatorBefore ? "elix-context-section" : undefined} key={action.id}>
        <button type="button" role="menuitem" disabled={action.disabled} className={action.danger ? "danger" : undefined} onClick={() => { if (!action.disabled) { action.onSelect?.(); close(); } }}>
          <span className="elix-context-icon" aria-hidden="true">{action.icon}</span>
          <span className="elix-context-copy"><strong>{action.label}</strong>{action.detail && <small>{action.detail}</small>}</span>
          {action.shortcut && <kbd>{action.shortcut}</kbd>}
        </button>
      </div>)}
    </div>,
    document.body
  );
}

function LegacyContextMenu({ x, y, label, actions, onClose, width = 224 }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x, y });
  const [submenu, setSubmenu] = useState<{ action: ContextMenuAction; anchor: HTMLElement } | null>(null);
  const closing = useRef(false);

  const requestClose = useCallback(() => {
    if (closing.current) return;
    const menu = menuRef.current;
    if (!menu || prefersReducedElixMotion()) { onClose(); return; }
    closing.current = true;
    const animation = playElixMotion(menu, elixMotion.menuOut);
    if (!animation) { onClose(); return; }
    void animation.finished.then(
      () => { animation.cancel(); onClose(); },
      () => { animation.cancel(); onClose(); }
    );
  }, [onClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const next = positionPointPopup(x, y, bounds.width, bounds.height);
    setPosition({ x: next.x, y: next.y });
    menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const motion = playElixMotion(menu, elixMotion.menuIn);
    if (motion) void motion.finished.then(() => motion.cancel(), () => motion.cancel());
  }, [x, y, actions.length]);

  useEffect(() => {
    const session = contextMenuService.begin(requestClose);
    return () => contextMenuService.end(session);
  }, [requestClose]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") requestClose(); };
    const closeOnResize = () => requestClose();
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [requestClose]);

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > div > button:not(:disabled)")];
    if (!buttons.length) return;
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    if (event.key === "ArrowRight") {
      const action = actions.filter((item) => !item.disabled)[current];
      if (action?.children?.length) { event.preventDefault(); setSubmenu({ action, anchor: buttons[current] }); }
      return;
    }
    if (event.key === "ArrowLeft") { event.preventDefault(); setSubmenu(null); return; }
    const index = event.key === "ArrowDown" ? (current + 1) % buttons.length
      : event.key === "ArrowUp" ? (current - 1 + buttons.length) % buttons.length
      : event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
      : -1;
    if (index < 0) return;
    event.preventDefault();
    buttons[index].focus();
  };

  return createPortal(
    <div className="elix-context-layer" role="presentation" onPointerDown={requestClose}>
      <div ref={menuRef} className="elix-context-menu" role="menu" aria-label={label} style={{ left: position.x, top: position.y, width }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()} onKeyDown={moveFocus}>
        {actions.map((action) => (
          <div className={action.separatorBefore ? "elix-context-section" : undefined} key={action.id}>
            <button
              type="button"
              role={typeof action.checked === "boolean" ? "menuitemcheckbox" : "menuitem"}
              aria-checked={typeof action.checked === "boolean" ? action.checked : undefined}
              className={action.danger ? "danger" : undefined}
              disabled={action.disabled}
              aria-haspopup={action.children?.length ? "menu" : undefined}
              onClick={() => {
                if (action.disabled) return;
                if (action.children?.length) { setSubmenu({ action, anchor: document.activeElement as HTMLElement }); return; }
                action.onSelect?.();
                requestClose();
              }}
              onPointerEnter={(event) => action.children?.length ? setSubmenu({ action, anchor: event.currentTarget }) : setSubmenu(null)}
            >
              <span className="elix-context-icon" aria-hidden="true">{action.icon}</span>
              <span className="elix-context-copy"><strong>{action.label}</strong>{action.detail && <small>{action.detail}</small>}</span>
              {action.shortcut && <kbd>{action.shortcut}</kbd>}
              {action.children?.length ? <ChevronRight className="elix-context-check" /> : action.checked && <Check className="elix-context-check" />}
            </button>
          </div>
        ))}
      </div>
      {submenu && <ContextSubmenu anchor={submenu.anchor} label={`${submenu.action.label} submenu`} actions={submenu.action.children ?? []} close={requestClose} back={() => setSubmenu(null)} />}
    </div>,
    document.body
  );
}

export function ContextMenu(props: ContextMenuProps) {
  return <LegacyContextMenu {...props} />;
}
