import { ChevronRight, LayoutGrid, Search, Settings } from "../../icons";
import { MovableHomeModule, type HomeModuleId, type HomeModuleState, type ShortcutPosition } from "./MovableHomeModule";
import { useClockText } from "../../hooks/useClockText";

type HomeModuleMap = Record<HomeModuleId, HomeModuleState>;

export function DesktopHomeModules({
  modules,
  selected,
  workspaceName,
  nextWorkspace,
  select,
  hide,
  move,
  resize,
  openWidgets,
  openSettings,
  openSearch
}: {
  modules: HomeModuleMap;
  selected: Set<HomeModuleId>;
  workspaceName: string;
  nextWorkspace(): void;
  select(event: React.MouseEvent<HTMLElement>, id: HomeModuleId): void;
  hide(id: HomeModuleId): void;
  move(id: HomeModuleId, position: ShortcutPosition): void;
  resize(id: HomeModuleId, size: Pick<HomeModuleState, "width" | "height">): void;
  openWidgets(): void;
  openSettings(): void;
  openSearch(): void;
}) {
  const { date, time } = useClockText();
  const shell = (id: HomeModuleId, className: string, children: React.ReactNode) => (
    <MovableHomeModule
      id={id}
      value={modules[id]}
      className={className}
      selected={selected.has(id)}
      select={(event) => select(event, id)}
      remove={() => hide(id)}
      move={(position) => move(id, position)}
      resize={(size) => resize(id, size)}
    >
      {children}
    </MovableHomeModule>
  );

  return (
    <>
      {shell("identity", "home-module-identity", (
        <>
          <div className="identity">
            <strong>ELIX</strong>
            <span />
            <button type="button" onClick={nextWorkspace}>{workspaceName}<ChevronRight size={13} /></button>
          </div>
          <nav aria-label="System shortcuts">
            <button type="button" onClick={openWidgets} aria-label="Widgets"><LayoutGrid size={18} /></button>
            <button type="button" onClick={openSettings} aria-label="Settings"><Settings size={18} /></button>
          </nav>
        </>
      ))}
      {shell("clock", "home-module-clock", (
        <div className="home-lead"><span className="context-line">{date}</span><h1>{time}</h1></div>
      ))}
      {shell("search", "home-module-search", (
        <button className="command-search" type="button" title="Double-click to search" onDoubleClick={(event) => { event.stopPropagation(); openSearch(); }}>
          <Search size={18} /><span>Search apps, files and settings</span><kbd>WIN</kbd>
        </button>
      ))}
    </>
  );
}
