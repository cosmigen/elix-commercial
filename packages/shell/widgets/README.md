# @deepseek-ai/dsh-shell-widgets

Authoritative reusable **Widget Runtime** for ELIX OS.

Widget Runtime provides a pluggable widget framework on top of the Cordis microkernel, decoupled from the Home surface layout while integrating seamlessly with desktop workspaces.

## Subsystem Architecture & Responsibilities

```text
Built-in / Extension Plugins (Clock, Calendar, Notes, System Monitor, Weather)
                                 ↓
                            ctx.widgets (Widget Runtime)
                                 ↓
                            ctx.home (Home / Desktop Surface)
                                 ↓
                            Surface Core (Phase 7)
                                 ↓
                            Native Core (Phase 5)
                                 ↓
                            Windows OS
```

- **Widget Runtime (`ctx.widgets`)**: Owns widget definition registration, schema validation, instance state lifecycle, placement constraints (dimensions, min/max, resize handles), custom renderers, action dispatching, and serialized persistence.
- **Home Surface (`ctx.home`)**: Hosts and renders widget instances alongside desktop icons/folders with pointer capture dragging, grid snapping, multi-monitor boundary handling, and context menu controls.
- **Surface Core (`ctx.surface`)**: Owns native Win32 HWND hosting and WebView2 composition.
- **Windows Context (`ctx.windowsContext`)**: Provides monitor display geometry and DPI scaling.

## Core Concepts

### 1. Definition vs Instance

- **Widget Definition** (`WidgetDefinition`): Registered by plugins or built-ins. Declares metadata, category, default & min/max dimensions, supported resize axes, default settings/state schemas, and renderer configurations.
- **Widget Instance** (`WidgetInstance`): An active placement of a widget on a specific monitor desktop. Tracks position (`x`, `y`), size (`width`, `height`), `zOrder`, pinned status, and arbitrary JSON-serializable custom `state`.

### 2. Built-in Widgets

The runtime bundles production-ready built-in widgets:
- **Analog / Digital Clock**: Configurable 12h/24h format, live second hand, timezone offset, liquid-glass aesthetic.
- **Interactive Calendar**: Month view, day selection, month navigation, current date highlighting.
- **Sticky Notes**: Persistent markdown/plain-text scratchpad with live debounced auto-save.

### 3. State Lifecycle & Persistence

Widget instances serialize cleanly into Home desktop state persistence:
- Supports schema versioning with seamless migration from legacy embedded widgets.
- Atomic state updates via `updateState(instanceId, patch)` and `patchInstance(instanceId, patch)`.
- Disposes cleanly on owner plugin unload or instance removal.

## Public Service API

```typescript
// Register & manage definitions
const unregister = ctx.widgets.registerDefinition(definition: WidgetDefinition)
ctx.widgets.unregisterDefinition(id: string): boolean
ctx.widgets.getDefinition(id: string): WidgetDefinition | undefined
ctx.widgets.listDefinitions(): readonly WidgetDefinition[]

// Instance lifecycle
const instance = ctx.widgets.createInstance(options: CreateWidgetInstanceOptions): WidgetInstance
ctx.widgets.removeInstance(id: string): boolean
ctx.widgets.getInstance(id: string): WidgetInstance | undefined
ctx.widgets.listInstances(): readonly WidgetInstance[]
ctx.widgets.listInstancesByMonitor(monitorId: string): readonly WidgetInstance[]

// Mutation & Actions
ctx.widgets.moveInstance(id: string, x: number, y: number): WidgetInstance | undefined
ctx.widgets.resizeInstance(id: string, width: number, height: number): WidgetInstance | undefined
ctx.widgets.setZOrder(id: string, zOrder: number): WidgetInstance | undefined
ctx.widgets.bringToFront(id: string): WidgetInstance | undefined
ctx.widgets.sendToBack(id: string): WidgetInstance | undefined
ctx.widgets.updateState(id: string, statePatch: Record<string, unknown>): WidgetInstance | undefined
ctx.widgets.dispatchAction(instanceId: string, action: string, payload?: unknown): Promise<unknown>

// Event Subscription
const unsubscribe = ctx.widgets.onEvent(listener: (event: WidgetLifecycleEvent) => void): () => void
```
