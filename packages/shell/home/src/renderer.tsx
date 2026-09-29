/**
 * React projection for the per-monitor Home WebView document.
 *
 * @module @deepseek-ai/dsh-home/renderer
 */

import React, { createElement, type CSSProperties, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  HomeRendererItem,
  HomeRendererSnapshot,
  HomeRendererWallpaper,
  HomeRendererWidget,
  RendererRect,
} from './renderer-protocol.ts'
import { HOME_RENDERER_CLIENT_SCRIPT } from './renderer-client.ts'
import { generateThemeTokensCss } from './theme-tokens.ts'

void React

/** Render the complete initial document loaded by Surface Core. */
export function renderHomeDocument(
  snapshot: HomeRendererSnapshot,
  nonce: string,
  themeOverrides?: Readonly<Record<string, string>>,
): string {
  const rootMarkup = renderHomeRoot(snapshot)
  const css = buildHomeRendererCss(themeOverrides ?? snapshot.themeTokens)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">',
    '<meta name="color-scheme" content="dark">',
    '<title>ELIX Home</title>',
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    rootMarkup,
    '<script nonce="' + escapeAttribute(nonce) + '">',
    HOME_RENDERER_CLIENT_SCRIPT,
    '</script>',
    '</body>',
    '</html>',
  ].join('')
}

/** Render one state replacement for an already-running Home document. */
export function renderHomeRoot(snapshot: HomeRendererSnapshot): string {
  return renderToStaticMarkup(createElement(HomeRoot, { snapshot }))
}

/** Root spatial projection for one monitor. */
export function HomeRoot({ snapshot }: { readonly snapshot: HomeRendererSnapshot }): ReactElement {
  const tokenOverrides = snapshot.themeTokens ?? {}
  const style = {
    width: snapshot.cssWidth,
    height: snapshot.cssHeight,
    '--elix-home-icon-size': snapshot.iconSize + 'px',
    ...(tokenOverrides as CSSProperties),
  } as CSSProperties
  const openFolder = snapshot.items.find(item => item.type === 'folder' && item.isOpen && !item.isFilesystemFolder)
  return (
    <main
      id="home-root"
      className="home-root"
      style={style}
      data-monitor-id={snapshot.monitorId}
      data-wallpaper-runtime={snapshot.wallpaperRuntime}
      aria-label={'ELIX Home on ' + snapshot.monitorName}
    >
      <WallpaperLayer wallpaper={snapshot.wallpaper} runtimeState={snapshot.wallpaperRuntime} />
      <ItemLayer items={snapshot.items} />
      <WidgetLayer widgets={snapshot.widgets} />
      {openFolder !== undefined ? <AppFolderOverlayView folder={openFolder} /> : null}
      <MarqueeLayer />
      <DragLayer />
      {snapshot.debugExclusions ? <ExclusionLayer exclusions={snapshot.exclusions} /> : null}
      {snapshot.items.length === 0 && snapshot.widgets.length === 0 ? (
        <p className="home-empty" aria-live="polite">Your Home is ready.</p>
      ) : null}
    </main>
  )
}

/** Wallpaper projection supporting compositor-backed image, video, and trusted live scenes. */
export function WallpaperLayer({
  wallpaper,
  runtimeState,
}: {
  readonly wallpaper: HomeRendererWallpaper
  readonly runtimeState: HomeRendererSnapshot['wallpaperRuntime']
}): ReactElement {
  const commonStyle: CSSProperties = {
    filter: ['blur(', wallpaper.blur, 'px) saturate(', wallpaper.saturation, '%)'].map(String).join(''),
  }
  let content: ReactElement
  if (wallpaper.kind === 'video' && wallpaper.assetUrl !== undefined) {
    content = (
      <video
        className={'wallpaper wallpaper-' + wallpaper.fit}
        style={commonStyle}
        src={wallpaper.assetUrl}
        autoPlay={runtimeState === 'active' || runtimeState === 'throttled'}
        muted
        loop
        playsInline
        preload="auto"
        tabIndex={-1}
        aria-hidden="true"
        data-wallpaper-media="video"
      />
    )
  } else if (wallpaper.kind === 'live') {
    content = (
      <div
        className={'wallpaper wallpaper-live wallpaper-live-' + wallpaper.source}
        style={commonStyle}
        aria-hidden="true"
        data-wallpaper-media="live"
      />
    )
  } else {
    const style: CSSProperties = {
      ...commonStyle,
      backgroundImage: wallpaper.kind === 'image' && wallpaper.assetUrl !== undefined
        ? 'url("' + wallpaper.assetUrl + '")'
        : wallpaper.kind === 'gradient'
          ? wallpaper.source
          : undefined,
      backgroundColor: wallpaper.kind === 'color' ? wallpaper.source : 'var(--elix-home-background)',
      backgroundSize: wallpaper.fit === 'stretch'
        ? '100% 100%'
        : wallpaper.fit === 'tile' || wallpaper.fit === 'center'
          ? 'auto'
          : wallpaper.fit === 'contain'
            ? 'contain'
            : 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: wallpaper.fit === 'tile' ? 'repeat' : 'no-repeat',
    }
    content = <div className="wallpaper" style={style} aria-hidden="true" data-wallpaper-media="static" />
  }
  return (
    <div className="wallpaper-frame" aria-hidden="true">
      {content}
      <div className="wallpaper-dim" style={{ opacity: wallpaper.dim / 100 }} />
    </div>
  )
}

/** Root desktop item grid projection. */
export function ItemLayer({ items }: { readonly items: readonly HomeRendererItem[] }): ReactElement {
  return (
    <section className="item-layer" role="grid" aria-label="Home items">
      {items.map(item => <HomeItemView key={item.id} item={item} />)}
    </section>
  )
}

/** One stable-ID Home item projection. */
export function HomeItemView({ item }: { readonly item: HomeRendererItem }): ReactElement {
  const style: CSSProperties = {
    left: item.rect.x,
    top: item.rect.y,
    width: item.rect.width,
    height: item.rect.height,
  }
  const isAppFolder = item.type === 'folder' && !item.isFilesystemFolder
  const className = [
    'home-item',
    'home-item-' + item.type.replaceAll(' ', '-'),
    isAppFolder ? 'is-app-folder' : '',
    item.selected ? 'is-selected' : '',
    item.isRenaming ? 'is-renaming' : '',
  ].filter(Boolean).join(' ')
  return (
    <div
      className={className}
      style={style}
      role="gridcell"
      tabIndex={item.selected ? 0 : -1}
      aria-selected={item.selected}
      aria-label={item.label}
      data-item-id={item.id}
      data-item-type={item.type}
      data-is-app-folder={isAppFolder ? 'true' : undefined}
      data-folder-color={item.folderColor}
    >
      <div className="home-item-visual">
        <ItemIcon item={item} />
      </div>
      {item.isRenaming ? (
        <input
          type="text"
          className="home-item-rename-input"
          defaultValue={item.label}
          data-item-id={item.id}
          autoFocus
          spellCheck={false}
        />
      ) : (
        <span className="home-item-label">{item.label}</span>
      )}
      <button
        type="button"
        className="home-item-resize-handle"
        data-item-id={item.id}
        aria-label={'Resize ' + item.label}
        title="Resize icon"
      />
    </div>
  )
}

/** Miniature application preview grid tile on desktop. */
export function AppFolderPreview({ item }: { readonly item: HomeRendererItem }): ReactElement {
  const children = item.folderChildren ?? []
  const preview = children.slice(0, 9)
  const color = item.folderColor ?? 'sky'
  return (
    <span
      className={'app-folder-preview app-folder-' + color}
      data-item-count={preview.length}
      aria-hidden="true"
    >
      {preview.length > 0 ? (
        preview.map(child => (
          <span className="app-folder-mini-icon" key={child.id} title={child.label}>
            {child.iconUrl !== undefined ? (
              <img src={child.iconUrl} alt="" draggable={false} />
            ) : (
              <span className="app-folder-mini-monogram">{initials(child.label)}</span>
            )}
          </span>
        ))
      ) : (
        <span className="app-folder-empty-glyph">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </span>
      )}
    </span>
  )
}

function ItemIcon({ item }: { readonly item: HomeRendererItem }): ReactElement {
  if (item.type === 'folder') {
    if (item.isFilesystemFolder) {
      return (
        <span className={'folder-icon folder-' + (item.folderColor ?? 'sky')} aria-hidden="true">
          <svg viewBox="0 0 48 38" className="folder-svg" fill="none">
            <path
              d="M2 8C2 5.79086 3.79086 4 6 4H18.5L22.5 8H42C44.2091 8 46 9.79086 46 12V32C46 34.2091 44.2091 36 42 36H6C3.79086 36 2 34.2091 2 32V8Z"
              fill="currentColor"
              fillOpacity="0.85"
            />
            <path
              d="M2 14H46V32C46 34.2091 44.2091 36 42 36H6C3.79086 36 2 34.2091 2 32V14Z"
              fill="currentColor"
            />
          </svg>
          <span className="folder-count">{item.folderItemCount ?? 0}</span>
        </span>
      )
    }
    return <AppFolderPreview item={item} />
  }
  if (item.type === 'shortcut') {
    return (
      <span className="item-icon item-icon-shortcut" aria-hidden="true">
        {item.iconUrl !== undefined ? (
          <img src={item.iconUrl} alt="" draggable={false} />
        ) : (
          <span className="item-monogram">{initials(item.label)}</span>
        )}
        <span className="shortcut-badge">↗</span>
      </span>
    )
  }
  if (item.type === 'widget') {
    return (
      <span className="widget-placeholder" aria-hidden="true">
        <span>{initials(item.widgetType ?? item.label)}</span>
      </span>
    )
  }
  return (
    <span className="item-icon" aria-hidden="true">
      {item.iconUrl !== undefined ? (
        <img src={item.iconUrl} alt="" draggable={false} />
      ) : (
        <span className="item-monogram">{initials(item.label)}</span>
      )}
    </span>
  )
}

const PAGE_SIZE = 12

/** Liquid-glass floating folder panel overlay within the Home WebView document. */
export function AppFolderOverlayView({ folder }: { readonly folder: HomeRendererItem }): ReactElement {
  const children = folder.folderChildren ?? []
  const pages = Math.max(1, Math.ceil(children.length / PAGE_SIZE))
  const color = folder.folderColor ?? 'sky'

  return (
    <div
      id="app-folder-overlay"
      className="app-folder-overlay"
      role="presentation"
      data-folder-id={folder.id}
    >
      <section
        id="app-folder-window"
        className={'app-folder-window app-folder-' + color}
        role="dialog"
        aria-modal="true"
        aria-label={folder.label + ' application folder'}
        data-folder-id={folder.id}
      >
        <div className="app-folder-specular" aria-hidden="true" />
        <header className="app-folder-header">
          <div className="app-folder-title-row">
            <button
              className="app-folder-title"
              type="button"
              data-folder-action="edit-title"
              title="Rename folder"
            >
              <strong>{folder.label}</strong>
            </button>
            <div className="app-folder-name-editor" hidden>
              <input
                className="app-folder-name-input"
                type="text"
                defaultValue={folder.label}
                maxLength={48}
                data-folder-id={folder.id}
                aria-label="Folder name"
              />
              <button
                type="button"
                className="app-folder-name-save"
                data-folder-action="save-title"
                aria-label="Save folder name"
              >
                ✓
              </button>
            </div>
            <button
              className="app-folder-manage"
              type="button"
              data-folder-action="toggle-manage"
              aria-label="Edit folder"
              title="Edit folder"
            >
              ✎
            </button>
            <button
              className="app-folder-color-cycle"
              type="button"
              data-folder-action="cycle-color"
              data-folder-color={color}
              aria-label={'Change folder color, current ' + color}
              title="Change folder color"
            >
              <span className="app-folder-color-swatch" aria-hidden="true" />
            </button>
            <button
              className="app-folder-close"
              type="button"
              data-folder-action="close"
              aria-label="Close folder"
              title="Close folder"
            >
              ✕
            </button>
          </div>
          <div className="app-folder-meta">
            <span className="app-folder-meta-count">
              {children.length} {children.length === 1 ? 'app' : 'apps'}
            </span>
          </div>
        </header>

        <div className={'app-folder-page-frame' + (children.length === 0 ? ' is-empty' : '')}>
          <button
            className="app-folder-page-arrow previous"
            type="button"
            data-folder-action="page-prev"
            aria-label="Previous page"
            disabled
          >
            ‹
          </button>
          <div className="app-folder-app-grid" data-page="0">
            {children.map((app, index) => (
              <div
                className="app-folder-app"
                key={app.id}
                data-folder-app-id={app.id}
                data-app-id={app.id}
                tabIndex={0}
                style={index >= PAGE_SIZE ? { display: 'none' } : undefined}
              >
                <button
                  type="button"
                  className="app-folder-app-btn"
                  data-folder-action="launch"
                  data-app-id={app.id}
                  aria-label={'Launch ' + app.label}
                >
                  <span className="app-icon app-folder-icon-ring">
                    {app.iconUrl !== undefined ? (
                      <img src={app.iconUrl} alt="" draggable={false} />
                    ) : (
                      <span className="item-monogram">{initials(app.label)}</span>
                    )}
                  </span>
                  <span className="app-folder-app-label" title={app.label}>{app.label}</span>
                </button>
                <button
                  className="app-folder-remove-app"
                  type="button"
                  data-folder-action="remove-app"
                  data-app-id={app.id}
                  aria-label={'Remove ' + app.label + ' from folder'}
                  title="Remove from folder"
                >
                  ✕
                </button>
              </div>
            ))}
            {children.length === 0 ? (
              <div className="app-folder-empty">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <strong>Drop apps here</strong>
                <span className="app-folder-empty-hint">Drag an application into this folder</span>
              </div>
            ) : null}
          </div>
          <button
            className="app-folder-page-arrow next"
            type="button"
            data-folder-action="page-next"
            aria-label="Next page"
            disabled={pages <= 1}
          >
            ›
          </button>
        </div>

        {pages > 1 ? (
          <div className="app-folder-pagination" aria-label="Folder pages">
            {Array.from({ length: pages }, (_, index) => (
              <button
                key={index}
                type="button"
                className={'app-folder-page-dot' + (index === 0 ? ' is-active' : '')}
                data-page-index={index}
                aria-label={`Page ${index + 1}`}
                aria-current={index === 0 ? 'true' : 'false'}
              />
            ))}
          </div>
        ) : null}

        <footer className="app-folder-footer">
          <button
            className="app-folder-delete"
            type="button"
            data-folder-action="delete"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Delete folder
          </button>
        </footer>

        <button
          type="button"
          className="app-folder-resize-grip"
          data-resize-dir="se"
          aria-label={'Resize ' + folder.label + ' folder'}
        />
        <button
          type="button"
          className="app-folder-resize-rail app-folder-resize-bottom"
          data-resize-dir="s"
          aria-label={'Resize ' + folder.label + ' folder height'}
        />
        <button
          type="button"
          className="app-folder-resize-rail app-folder-resize-corner"
          data-resize-dir="se"
          aria-label={'Resize ' + folder.label + ' folder'}
        />
      </section>
    </div>
  )
}

/** Desktop widget instances layer. */
export function WidgetLayer({ widgets }: { readonly widgets: readonly HomeRendererWidget[] }): ReactElement {
  return (
    <section className="widget-layer" aria-label="Home widgets">
      {widgets.map(w => <HomeWidgetView key={w.id} widget={w} />)}
    </section>
  )
}

/** Individual desktop widget container. */
export function HomeWidgetView({ widget }: { readonly widget: HomeRendererWidget }): ReactElement {
  const style: CSSProperties = {
    left: widget.rect.x,
    top: widget.rect.y,
    width: widget.rect.width,
    height: widget.rect.height,
    zIndex: widget.zOrder,
  }
  return (
    <article
      id={'widget-' + widget.id}
      className="home-widget"
      style={style}
      data-widget-id={widget.id}
      data-widget-definition={widget.definitionId}
      data-min-width={widget.minSize ? widget.minSize.width : undefined}
      data-min-height={widget.minSize ? widget.minSize.height : undefined}
      data-max-width={widget.maxSize ? widget.maxSize.width : undefined}
      data-max-height={widget.maxSize ? widget.maxSize.height : undefined}
      tabIndex={0}
      aria-label={widget.title + ' widget'}
    >
      <header className="widget-header" data-drag-handle="true">
        <span className="widget-title">{widget.title}</span>
        <button
          type="button"
          className="widget-close-btn"
          data-widget-action="close"
          data-widget-id={widget.id}
          title="Remove Widget"
          aria-label="Remove Widget"
        >
          ×
        </button>
      </header>
      <div
        className="widget-content"
        dangerouslySetInnerHTML={{ __html: widget.contentHtml }}
      />
      <div
        className="widget-resize-handle"
        data-resize-handle="se"
        data-widget-id={widget.id}
        title="Resize widget"
        aria-hidden="true"
      />
    </article>
  )
}

/** Ephemeral marquee visual owned by the renderer interaction adapter. */
export function MarqueeLayer(): ReactElement {
  return <div id="home-marquee" className="home-marquee" hidden aria-hidden="true" />
}

/** Ephemeral drag feedback layer owned by the renderer interaction adapter. */
export function DragLayer(): ReactElement {
  return <div id="home-drag-status" className="home-drag-status" aria-live="polite" />
}

/** Development-only projection of source-neutral Home exclusion rectangles. */
export function ExclusionLayer({ exclusions }: { readonly exclusions: readonly RendererRect[] }): ReactElement {
  return (
    <div className="exclusion-layer" aria-hidden="true">
      {exclusions.map((rect, index) => (
        <div
          className="exclusion-zone"
          key={index}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          Home exclusion
        </div>
      ))}
    </div>
  )
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean)
  return words.slice(0, 2).map(word => word[0]?.toUpperCase() ?? '').join('') || '•'
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * Build serialized CSS styles for the Home renderer with token defaults and optional overrides.
 *
 * @param themeOverrides - Optional map of CSS custom property overrides to apply.
 * @returns Complete serialized CSS stylesheet for Home WebView.
 */
export function buildHomeRendererCss(themeOverrides?: Readonly<Record<string, string>>): string {
  return [
    ':root{',
    generateThemeTokensCss(themeOverrides),
    'font-family:var(--elix-font-ui);',
    'color:var(--elix-text-primary);',
    'background:var(--elix-home-background);',
    'user-select:none;-webkit-user-select:none',
    '}',
    '*{box-sizing:border-box}',
    'html,body{width:100%;height:100%;margin:0;overflow:hidden}',
    'body{background:var(--elix-home-background)}',
    '.home-root{position:relative;isolation:isolate;overflow:hidden;outline:none;background:var(--elix-home-background)}',
    '.wallpaper-frame,.wallpaper{position:absolute;inset:0;width:100%;height:100%}',
    '.wallpaper-frame{z-index:-2;overflow:hidden;background:var(--elix-home-background)}',
    '.wallpaper{object-fit:cover;transform:scale(1.01)}',
    '.wallpaper-contain{object-fit:contain;background:var(--elix-home-background)}',
    '.wallpaper-stretch{object-fit:fill}',
    '.wallpaper-center{object-fit:none}',
    '.wallpaper-tile{object-fit:none}',
    '.wallpaper-dim{position:absolute;inset:0;background:var(--elix-home-dim-background);pointer-events:none}',
    '.wallpaper-live{background:var(--elix-home-background);overflow:hidden}',
    '.wallpaper-live::before,.wallpaper-live::after{content:"";position:absolute;border-radius:50%;filter:blur(56px);will-change:transform}',
    '.wallpaper-live-elix-flow{background:linear-gradient(145deg,#0e1018 0%,#24130e 46%,#090a0d 100%)}',
    '.wallpaper-live-elix-flow::before{width:48vmax;height:48vmax;left:-10vmax;top:-18vmax;background:rgba(255,112,54,.42);animation:elix-drift 20s ease-in-out infinite alternate}',
    '.wallpaper-live-elix-flow::after{width:42vmax;height:42vmax;right:-12vmax;bottom:-16vmax;background:rgba(114,76,255,.26);animation:elix-drift 27s ease-in-out infinite alternate-reverse}',
    '.wallpaper-live-quiet-orbit{background:radial-gradient(circle at 55% 42%,#27304b 0%,#111521 35%,#080a0f 78%)}',
    '.wallpaper-live-quiet-orbit::before{width:36vmax;height:36vmax;left:12vmax;top:8vmax;border:1px solid rgba(255,255,255,.2);box-shadow:0 0 90px rgba(100,150,255,.15);animation:elix-orbit 24s linear infinite}',
    '.wallpaper-live-quiet-orbit::after{width:10vmax;height:10vmax;left:46vmax;top:18vmax;background:rgba(241,169,105,.38);animation:elix-drift 16s ease-in-out infinite alternate}',
    '.home-root[data-wallpaper-runtime="throttled"] .wallpaper-live::before,.home-root[data-wallpaper-runtime="throttled"] .wallpaper-live::after{animation-duration:48s}',
    '.home-root:not([data-wallpaper-runtime="active"]):not([data-wallpaper-runtime="throttled"]) .wallpaper-live::before,.home-root:not([data-wallpaper-runtime="active"]):not([data-wallpaper-runtime="throttled"]) .wallpaper-live::after{animation-play-state:paused}',
    '@keyframes elix-drift{from{transform:translate3d(-4%,2%,0) scale(.94)}to{transform:translate3d(12%,-8%,0) scale(1.08)}}',
    '@keyframes elix-orbit{to{transform:rotate(360deg)}}',
    '.item-layer{position:absolute;inset:0;z-index:2}',
    '.home-item{position:absolute;display:flex;container-type:size;min-width:0;box-sizing:border-box;flex-direction:column;align-items:center;justify-content:flex-start;padding:.4em .3em;border:1px solid transparent;border-radius:var(--elix-desktop-item-radius);touch-action:none;cursor:default;outline:none;transition:background-color var(--elix-ui-transition-fast) ease,border-color var(--elix-ui-transition-fast) ease,box-shadow var(--elix-ui-transition-fast) ease}',
    '.home-item:hover{background:var(--elix-desktop-item-hover-bg)}',
    '.home-item:focus-visible{border-color:var(--elix-desktop-item-focus-border);box-shadow:var(--elix-desktop-item-focus-shadow)}',
    '.home-item.is-selected{background:var(--elix-desktop-item-selected-bg);border-color:var(--elix-desktop-item-selected-border);box-shadow:var(--elix-desktop-item-selected-shadow)}',
    '.home-item.is-folder-target{background:rgba(56,189,248,.22);border-color:rgba(56,189,248,.75);box-shadow:0 0 0 2px rgba(56,189,248,.22),var(--elix-surface-shadow-sm);transform:scale(1.04)}',
    '.home-item.is-folder-potential{background:rgba(167,139,250,.12);border-color:rgba(167,139,250,.4);box-shadow:0 0 0 1px rgba(167,139,250,.4);transform:scale(1.02);transition:transform var(--elix-ui-transition-fast) ease,background-color var(--elix-ui-transition-fast) ease}',
    '.home-item.is-folder-armed,.home-item.is-new-folder-target{background:rgba(167,139,250,.26);border-color:rgba(167,139,250,.9);box-shadow:0 0 0 2px rgba(167,139,250,.9),var(--elix-surface-shadow-md);transform:scale(1.06);transition:transform var(--elix-ui-transition-fast) cubic-bezier(0.2,0,0,1)}',
    '.home-item.is-dragging{z-index:8;transition:none;filter:drop-shadow(0 16px 28px rgba(0,0,0,.45))}',
    '.home-item-resize-handle{position:absolute;right:0;bottom:0;inline-size:clamp(.8rem,22cqi,1.15rem);block-size:auto;aspect-ratio:1;padding:0;border:0;background:transparent;cursor:nwse-resize;opacity:0;pointer-events:none;z-index:10}',
    '.home-item-resize-handle::after{content:"";position:absolute;right:12%;bottom:12%;inline-size:42%;block-size:42%;border-right:max(1px,.1em) solid rgba(255,255,255,.7);border-bottom:max(1px,.1em) solid rgba(255,255,255,.7)}',
    '.home-item.is-selected .home-item-resize-handle,.home-item:focus-within .home-item-resize-handle{opacity:1;pointer-events:auto}',
    '.home-item-visual{display:grid;place-items:center;inline-size:var(--elix-home-icon-size);inline-size:min(76cqi,56cqb);max-inline-size:100%;block-size:auto;aspect-ratio:1;flex:none;pointer-events:none}',
    '.item-icon{position:relative;display:grid;container-type:inline-size;place-items:center;inline-size:100%;max-inline-size:100%;block-size:auto;aspect-ratio:1;border-radius:var(--elix-desktop-item-icon-radius);background:var(--elix-desktop-item-icon-bg);border:1px solid var(--elix-desktop-item-icon-border);box-shadow:var(--elix-desktop-item-icon-shadow);overflow:hidden}',
    '.item-icon img{position:absolute;inset:0;display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;object-position:center;z-index:1}',
    '.item-icon-shortcut .shortcut-badge{position:absolute;bottom:4cqi;right:4cqi;inline-size:28cqi;block-size:auto;aspect-ratio:1;border-radius:var(--elix-radius-sm);background:var(--elix-desktop-item-shortcut-badge-bg);border:1px solid var(--elix-surface-border);color:var(--elix-desktop-item-shortcut-badge-color);font-size:16cqi;font-weight:700;display:grid;place-items:center;line-height:1;z-index:2}',
    '.item-monogram{font-size:36cqi;font-weight:600;letter-spacing:.02em;color:var(--elix-text-primary)}',
    '.folder-icon{position:relative;display:grid;place-items:center;inline-size:100%;max-inline-size:100%;block-size:auto;aspect-ratio:7/6;color:var(--elix-accent)}',
    '.folder-svg{width:100%;height:100%;filter:drop-shadow(0 4px 12px rgba(0,0,0,.3))}',
    '.folder-count{position:absolute;right:8px;bottom:6px;z-index:1;font-size:9px;font-weight:700;color:var(--elix-color-white);background:rgba(15,23,42,.85);padding:1px 4px;border-radius:var(--elix-radius-sm)}',
    '.folder-mint{color:#34d399}',
    '.folder-violet{color:#a78bfa}',
    '.folder-amber{color:#fbbf24}',
    '.folder-rose{color:#fb7185}',
    '.folder-graphite{color:#94a3b8}',
    '.widget-placeholder{display:grid;place-items:center;width:100%;height:100%;border-radius:var(--elix-widget-radius);background:var(--elix-widget-background);border:1px solid var(--elix-widget-border);backdrop-filter:blur(var(--elix-widget-blur))}',
    '.widget-placeholder span{font-size:28px;font-weight:600;color:var(--elix-text-secondary)}',
    '.home-item-label{inline-size:100%;max-inline-size:100%;min-width:0;min-block-size:2.5em;margin-top:.3em;padding:.15em .25em;box-sizing:border-box;flex:none;border-radius:var(--elix-radius-sm);color:var(--elix-desktop-item-label);font-size:clamp(.55rem,17cqi,.86rem);font-weight:500;line-height:1.25;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.95),0 0 10px rgba(0,0,0,.8);overflow:visible;overflow-wrap:anywhere;word-break:normal;white-space:normal;display:block;pointer-events:none}',
    '.home-item-rename-input{width:100%;max-width:100%;margin-top:2px;padding:2px 4px;background:var(--elix-desktop-item-rename-bg);border:1px solid var(--elix-desktop-item-rename-border);border-radius:var(--elix-radius-sm);color:var(--elix-desktop-item-rename-color);font-size:11.5px;font-family:inherit;text-align:center;outline:none;box-shadow:var(--elix-desktop-item-rename-shadow)}',
    '.widget-layer{position:absolute;inset:0;z-index:3;pointer-events:none}',
    '.home-widget{position:absolute;display:flex;container-type:size;flex-direction:column;border-radius:var(--elix-widget-radius);background:var(--elix-widget-background);border:1px solid var(--elix-widget-border);box-shadow:var(--elix-widget-shadow);backdrop-filter:blur(var(--elix-widget-blur));-webkit-backdrop-filter:blur(var(--elix-widget-blur));overflow:hidden;touch-action:none;outline:none;pointer-events:auto;user-select:none;transition:box-shadow var(--elix-ui-transition-fast) ease,border-color var(--elix-ui-transition-fast) ease}',
    '.home-widget:hover{border-color:rgba(255,255,255,.2);box-shadow:0 20px 44px rgba(0,0,0,.45)}',
    '.home-widget.is-dragging{opacity:.95;cursor:grabbing;z-index:99!important;transition:none;filter:drop-shadow(0 20px 40px rgba(0,0,0,.6))}',
    '.widget-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,.03);border-bottom:1px solid var(--elix-surface-border-subtle);cursor:grab}',
    '.home-widget.is-dragging .widget-header{cursor:grabbing}',
    '.widget-title{font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--elix-widget-title-color)}',
    '.widget-close-btn{background:none;border:none;color:rgba(255,255,255,.4);font-size:20px;line-height:1;padding:0 4px;cursor:pointer;border-radius:var(--elix-radius-sm);transition:color var(--elix-ui-transition-fast) ease,background var(--elix-ui-transition-fast) ease}',
    '.widget-close-btn:hover{color:#f87171;background:rgba(248,113,113,.15)}',
    '.widget-content{flex:1;padding:12px;overflow:auto;display:flex;flex-direction:column;position:relative;color:var(--elix-widget-body-color)}',
    '.widget-resize-handle{position:absolute;right:0;bottom:0;inline-size:clamp(1rem,8cqi,1.5rem);block-size:auto;aspect-ratio:1;cursor:se-resize;z-index:10}',
    '.widget-resize-handle::after{content:"";position:absolute;right:18%;bottom:18%;inline-size:38%;block-size:38%;border-right:max(1px,.12em) solid rgba(255,255,255,.55);border-bottom:max(1px,.12em) solid rgba(255,255,255,.55)}',
    '.widget-clock{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%}',
    '.clock-display{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center}',
    '.clock-time{font-size:42px;font-weight:700;letter-spacing:-.02em;color:var(--elix-text-primary);font-variant-numeric:tabular-nums;line-height:1.1;display:flex;align-items:baseline;gap:6px}',
    '.clock-ampm{font-size:13px;font-weight:600;color:var(--elix-accent);text-transform:uppercase}',
    '.clock-date{margin-top:4px;font-size:12px;font-weight:500;color:var(--elix-text-secondary)}',
    '.calendar-display{display:flex;flex-direction:column;height:100%}',
    '.calendar-header{font-size:13px;font-weight:600;color:var(--elix-accent);margin-bottom:8px;text-align:center}',
    '.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center;font-size:11.5px}',
    '.cal-day-header{font-weight:600;color:rgba(255,255,255,.4);padding-bottom:4px}',
    '.cal-cell{padding:4px 0;border-radius:var(--elix-radius-sm);color:rgba(255,255,255,.8)}',
    '.cal-cell.is-today{background:var(--elix-accent);color:#0f172a;font-weight:700}',
    '.notes-display{display:flex;flex-direction:column;height:100%}',
    '.notes-textarea{flex:1;width:100%;height:100%;background:transparent;border:none;color:var(--elix-text-primary);font-family:inherit;font-size:12px;line-height:1.5;resize:none;outline:none;padding:0}',
    '.notes-textarea::placeholder{color:var(--elix-text-muted)}',
    '.home-marquee{position:absolute;z-index:12;border:1px solid var(--elix-home-marquee-border);border-radius:var(--elix-radius-sm);background:var(--elix-home-marquee-fill);box-shadow:var(--elix-home-marquee-shadow);pointer-events:none}',
    '.home-drag-status{position:absolute;left:-9999px}',
    '.exclusion-layer{position:absolute;inset:0;z-index:5;pointer-events:none}',
    '.exclusion-zone{position:absolute;display:grid;place-items:center;border:1px dashed rgba(255,188,99,.8);border-radius:14px;background:repeating-linear-gradient(135deg,rgba(255,155,70,.1),rgba(255,155,70,.1) 8px,rgba(255,155,70,.18) 8px,rgba(255,155,70,.18) 16px);color:rgba(255,226,193,.9);font:600 11px/1 "Segoe UI",sans-serif;letter-spacing:.08em;text-transform:uppercase}',
    '.home-empty{position:absolute;left:50%;bottom:42px;z-index:2;transform:translateX(-50%);margin:0;padding:8px 14px;border-radius:var(--elix-radius-full);background:var(--elix-home-empty-bg);color:var(--elix-home-empty-color);font-size:12px;backdrop-filter:blur(var(--elix-blur-md));pointer-events:none;border:1px solid var(--elix-home-empty-border)}',
    '.app-folder-preview{position:relative;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);inline-size:100%;max-inline-size:100%;block-size:auto;aspect-ratio:1;padding:10%;gap:5%;border-radius:var(--elix-folder-tile-radius);background:var(--elix-folder-tile-bg);border:1px solid var(--elix-folder-tile-border);box-shadow:var(--elix-folder-tile-shadow);backdrop-filter:blur(var(--elix-folder-tile-blur));-webkit-backdrop-filter:blur(var(--elix-folder-tile-blur));overflow:hidden;box-sizing:border-box}',
    '.app-folder-preview[data-item-count="0"]{display:grid;place-items:center}',
    '.app-folder-preview[data-item-count="1"],.app-folder-preview[data-item-count="2"],.app-folder-preview[data-item-count="3"],.app-folder-preview[data-item-count="4"]{grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(2,1fr);padding:12%;gap:7%}',
    '.app-folder-empty-glyph{display:grid;place-items:center;color:var(--elix-text-muted)}',
    '.app-folder-mini-icon{position:relative;display:grid;place-items:center;width:100%;height:100%;min-width:0;min-height:0;border-radius:20%;background:rgba(255,255,255,.12);overflow:hidden}',
    '.app-folder-mini-icon img{position:absolute;inset:0;display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;object-position:center}',
    '.app-folder-mini-monogram{font-size:45%;font-weight:700;color:var(--elix-color-white);line-height:1}',
    '.app-folder-mint{border-color:rgba(52,211,153,.35)}',
    '.app-folder-sky{border-color:rgba(255,255,255,.28)}',
    '.app-folder-violet{border-color:rgba(167,139,250,.35)}',
    '.app-folder-amber{border-color:rgba(251,191,36,.35)}',
    '.app-folder-rose{border-color:rgba(251,113,133,.35)}',
    '.app-folder-graphite{border-color:rgba(255,255,255,.22)}',
    '.app-folder-overlay{position:absolute;inset:0;z-index:30;display:grid;place-items:center;background:var(--elix-folder-overlay-backdrop);backdrop-filter:blur(var(--elix-folder-overlay-blur)) saturate(140%);-webkit-backdrop-filter:blur(var(--elix-folder-overlay-blur)) saturate(140%)}',
    '.app-folder-window{position:relative;width:var(--folder-window-width,460px);min-width:320px;max-width:760px;height:var(--folder-window-height,auto);min-height:300px;max-height:var(--folder-window-max-height,640px);display:flex;flex-direction:column;container-type:inline-size;background:var(--elix-folder-overlay-background);backdrop-filter:blur(var(--elix-folder-overlay-window-blur)) saturate(190%) contrast(104%);-webkit-backdrop-filter:blur(var(--elix-folder-overlay-window-blur)) saturate(190%) contrast(104%);border:1px solid var(--elix-folder-overlay-border);box-shadow:var(--elix-folder-overlay-shadow);border-radius:var(--elix-folder-overlay-radius);overflow:hidden;user-select:none;touch-action:none}',
    '.app-folder-specular{position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.8) 50%,transparent 100%);pointer-events:none;z-index:20}',
    '.app-folder-window.app-folder-mint{--folder-accent:#34d399;border-color:rgba(52,211,153,.35);box-shadow:0 32px 80px -12px rgba(0,0,0,.78),0 1px 0 0 rgba(52,211,153,.5) inset,0 0 0 1px rgba(255,255,255,.1) inset}',
    '.app-folder-window.app-folder-sky{--folder-accent:#7dd3fc;border-color:rgba(255,255,255,.28);box-shadow:0 32px 80px -12px rgba(0,0,0,.78),0 1px 0 0 rgba(255,255,255,.55) inset,0 0 0 1px rgba(255,255,255,.12) inset}',
    '.app-folder-window.app-folder-violet{--folder-accent:#a78bfa;border-color:rgba(167,139,250,.35);box-shadow:0 32px 80px -12px rgba(0,0,0,.78),0 1px 0 0 rgba(167,139,250,.5) inset,0 0 0 1px rgba(255,255,255,.1) inset}',
    '.app-folder-window.app-folder-amber{--folder-accent:#fbbf24;border-color:rgba(251,191,36,.35);box-shadow:0 32px 80px -12px rgba(0,0,0,.78),0 1px 0 0 rgba(251,191,36,.5) inset,0 0 0 1px rgba(255,255,255,.1) inset}',
    '.app-folder-window.app-folder-rose{--folder-accent:#fb7185;border-color:rgba(251,113,133,.35);box-shadow:0 32px 80px -12px rgba(0,0,0,.78),0 1px 0 0 rgba(251,113,133,.5) inset,0 0 0 1px rgba(255,255,255,.1) inset}',
    '.app-folder-window.app-folder-graphite{--folder-accent:#94a3b8;border-color:rgba(255,255,255,.22);box-shadow:0 32px 80px -12px rgba(0,0,0,.78),0 1px 0 0 rgba(255,255,255,.45) inset,0 0 0 1px rgba(255,255,255,.08) inset}',
    '.app-folder-header{padding:16px 20px 8px;display:flex;flex-direction:column;gap:4px;border-bottom:1px solid var(--elix-surface-border-subtle);position:relative;z-index:2}',
    '.app-folder-title-row{display:flex;align-items:center;gap:8px;width:100%}',
    '.app-folder-title{background:none;border:none;color:var(--elix-folder-title-color);font-size:18px;font-weight:700;text-align:left;padding:2px 8px;border-radius:var(--elix-radius-md);cursor:pointer;flex:1;outline:none;font-family:inherit;line-height:1.2;transition:background var(--elix-ui-transition-fast) ease;letter-spacing:-.01em}',
    '.app-folder-title:hover{background:var(--elix-folder-title-hover-bg)}',
    '.app-folder-name-editor{display:flex;align-items:center;gap:6px;flex:1}',
    '.app-folder-name-input{flex:1;background:rgba(12,14,20,.85);border:1px solid var(--elix-surface-border-strong);border-radius:var(--elix-radius-md);color:var(--elix-color-white);font-size:15px;font-weight:600;padding:4px 10px;outline:none;box-shadow:0 0 0 2px rgba(255,255,255,.16);font-family:inherit}',
    '.app-folder-name-save,.app-folder-manage,.app-folder-color-cycle,.app-folder-close{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:10px;color:rgba(255,255,255,.8);width:30px;height:30px;display:grid;place-items:center;font-size:13px;cursor:pointer;transition:all var(--elix-ui-transition-fast) ease;padding:0;outline:none}',
    '.app-folder-name-save:hover,.app-folder-manage:hover,.app-folder-color-cycle:hover{background:rgba(255,255,255,.20);color:var(--elix-color-white);border-color:rgba(255,255,255,.35)}',
    '.app-folder-close:hover{background:rgba(248,113,113,.25);color:#f87171;border-color:rgba(248,113,113,.45)}',
    '.app-folder-window.is-managing .app-folder-manage{background:rgba(255,255,255,.25);border-color:rgba(255,255,255,.7);color:var(--elix-color-white);box-shadow:0 0 12px rgba(255,255,255,.25)}',
    '.app-folder-color-cycle{display:none}',
    '.app-folder-window.is-managing .app-folder-color-cycle{display:grid}',
    '.app-folder-color-swatch{width:14px;height:14px;border-radius:9999px;background:var(--folder-accent,rgba(255,255,255,.78));border:1px solid rgba(255,255,255,.42);box-shadow:0 1px 8px rgba(0,0,0,.28)}',
    '.app-folder-meta{font-size:11.5px;color:var(--elix-text-muted);font-weight:500;padding-left:8px}',
    '.app-folder-page-frame{flex:1;position:relative;display:flex;align-items:center;padding:12px 10px;min-height:180px;z-index:2}',
    '.app-folder-page-arrow{width:28px;height:52px;border-radius:var(--elix-radius-md);border:none;background:rgba(255,255,255,.05);color:rgba(255,255,255,.65);font-size:22px;line-height:1;display:grid;place-items:center;cursor:pointer;transition:all var(--elix-ui-transition-fast) ease;z-index:2;outline:none;padding:0}',
    '.app-folder-page-arrow:hover:not(:disabled){background:rgba(255,255,255,.16);color:var(--elix-color-white)}',
    '.app-folder-page-arrow:disabled{opacity:.12;cursor:default}',
    '.app-folder-app-grid{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(5.5rem,28cqi),1fr));gap:clamp(.4rem,2cqi,.75rem);padding:clamp(.35rem,1.5cqi,.75rem);min-height:160px;align-content:start}',
    '.app-folder-app{position:relative;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:clamp(.35rem,1.2cqi,.65rem);border-radius:var(--elix-radius-xl);cursor:pointer;transition:background var(--elix-ui-transition-fast) ease,transform var(--elix-ui-transition-fast) ease;touch-action:none;outline:none}',
    '.app-folder-app:hover{background:rgba(255,255,255,.10)}',
    '.app-folder-app.is-dragging{opacity:.4;filter:grayscale(0.5)}',
    '.app-folder-app.is-drop-target{background:rgba(255,255,255,.15);box-shadow:0 0 0 2px rgba(255,255,255,.7),inset 0 0 14px rgba(255,255,255,.1)}',
    '.app-folder-app-btn{background:none;border:none;padding:0;display:flex;min-width:0;flex-direction:column;align-items:center;cursor:pointer;color:inherit;font:inherit;outline:none;width:100%}',
    '.app-folder-icon-ring{inline-size:12cqi;block-size:auto;aspect-ratio:1;border-radius:var(--elix-radius-xl);display:grid;flex:none;place-items:center;background:linear-gradient(145deg,rgba(255,255,255,.20),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.24);box-shadow:0 6px 16px rgba(0,0,0,.28),0 1px 0 0 rgba(255,255,255,.35) inset;overflow:hidden;position:relative}',
    '.app-folder-icon-ring img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}',
    '.app-folder-app-label{inline-size:100%;min-width:0;min-block-size:2.5em;margin-top:.5em;font-size:clamp(.72rem,2.8cqi,.95rem);line-height:1.25;font-weight:500;color:var(--elix-text-primary);text-align:center;overflow:visible;overflow-wrap:anywhere;white-space:normal;display:block;pointer-events:none}',
    '.app-folder-remove-app{position:absolute;top:2px;right:4px;width:18px;height:18px;border-radius:50%;background:var(--elix-danger);border:1px solid rgba(255,255,255,.5);color:var(--elix-color-white);font-size:9px;font-weight:700;display:none;place-items:center;cursor:pointer;line-height:1;padding:0;z-index:5;transition:transform 100ms ease}',
    '.app-folder-remove-app:hover{transform:scale(1.15);background:var(--elix-danger-hover)}',
    '.app-folder-window.is-managing .app-folder-remove-app{display:grid}',
    '.app-folder-empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:32px 0;color:var(--elix-text-muted)}',
    '.app-folder-empty-hint{font-size:11px;color:var(--elix-text-muted)}',
    '.app-folder-pagination{display:flex;align-items:center;justify-content:center;gap:8px;padding-bottom:12px;z-index:2}',
    '.app-folder-page-dot{width:6px;height:6px;border-radius:50%;border:none;background:rgba(255,255,255,.3);cursor:pointer;padding:0;transition:all var(--elix-ui-transition-fast) ease}',
    '.app-folder-page-dot.is-active{background:var(--elix-color-white);box-shadow:0 0 8px rgba(255,255,255,.85);transform:scale(1.4)}',
    '.app-folder-footer{display:none;padding:10px 18px;border-top:1px solid var(--elix-surface-border-subtle);justify-content:flex-end;z-index:2}',
    '.app-folder-window.is-managing .app-folder-footer{display:flex}',
    '.app-folder-delete{background:var(--elix-danger-bg);border:1px solid rgba(239,68,68,.4);border-radius:10px;color:#f87171;padding:6px 14px;font-size:12px;font-weight:600;display:inline-flex;align-items:center;cursor:pointer;transition:all var(--elix-ui-transition-fast) ease;font-family:inherit}',
    '.app-folder-delete:hover{background:rgba(239,68,68,.28);color:var(--elix-color-white);border-color:rgba(239,68,68,.7)}',
    '.app-folder-resize-grip{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:se-resize;z-index:10;background:none;border:none;padding:0}',
    '.app-folder-resize-grip::after{content:"";position:absolute;right:4px;bottom:4px;width:6px;height:6px;border-right:2px solid rgba(255,255,255,.4);border-bottom:2px solid rgba(255,255,255,.4)}',
    '.app-folder-resize-rail{position:absolute;background:none;border:none;padding:0;z-index:9}',
    '.app-folder-resize-bottom{bottom:0;left:0;right:18px;height:6px;cursor:s-resize}',
    '.app-folder-resize-corner{bottom:0;right:0;width:18px;height:18px;cursor:se-resize}',
    '@media (prefers-reduced-motion:reduce){.wallpaper-live::before,.wallpaper-live::after{animation:none!important}.home-item,.home-widget{transition:none}}',
  ].join('')
}

export const HOME_RENDERER_CSS = buildHomeRendererCss()
