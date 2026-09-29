/**
 * Authoritative types, models, and contracts for ELIX Widget Runtime.
 *
 * @module @deepseek-ai/dsh-shell-widgets/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WidgetService } from './service.ts'

/** Branded identifier for a widget definition. */
export type WidgetDefinitionId = Branded<'WidgetDefinitionId'>

/** Branded identifier for a placed widget instance. */
export type WidgetInstanceId = Branded<'WidgetInstanceId'>

/** Physical pixel dimensions. */
export interface Size {
  readonly width: number
  readonly height: number
}

/** Virtual-screen physical coordinate position. */
export interface Position {
  readonly x: number
  readonly y: number
}

/** Virtual-screen physical bounding box rectangle. */
export interface Rect extends Position, Size {}

/** Declarative renderer specification for a widget definition. */
export type WidgetRendererSpec =
  | { readonly type: 'component'; readonly componentName: string }
  | { readonly type: 'html'; readonly html: string }

/** Definition contract for a registerable widget type. */
export interface WidgetDefinition {
  /** Unique widget definition identifier (e.g. 'clock', 'calendar', 'notes'). */
  readonly id: string
  /** Subsystem or plugin owner identifier (e.g. 'elix.builtin'). */
  readonly ownerId: string
  /** Human-readable title. */
  readonly title: string
  /** Optional subtitle or description. */
  readonly description?: string | undefined
  /** Semantic version string. */
  readonly version: string
  /** Default physical pixel dimensions. */
  readonly defaultSize: Size
  /** Minimum permissible physical pixel dimensions. */
  readonly minSize: Size
  /** Maximum permissible physical pixel dimensions. */
  readonly maxSize?: Size | undefined
  /** Whether the widget can be resized on the Home desktop. Defaults to true. */
  readonly resizable?: boolean | undefined
  /** Default configuration options. */
  readonly defaultConfig?: Record<string, unknown> | undefined
  /** Initial instance state template. */
  readonly defaultState?: Record<string, unknown> | undefined
  /** Declarative renderer specification. */
  readonly renderer: WidgetRendererSpec
  /** Arbitrary non-executable metadata. */
  readonly metadata?: Record<string, unknown> | undefined
}

/** Operational lifecycle of a spawned widget instance. */
export type WidgetInstanceLifecycle = 'mounted' | 'unmounted' | 'suspended' | 'destroyed'

/** Concrete active widget instance placed on a Home monitor. */
export interface WidgetInstance {
  /** Unique instance identifier. */
  readonly id: string
  /** Referenced definition identifier. */
  readonly definitionId: string
  /** Owning subsystem identifier inherited from the definition. */
  readonly ownerId: string
  /** Target monitor identifier. */
  readonly monitorId: string
  /** Canonical physical virtual-screen position. */
  readonly position: Position
  /** Canonical physical dimensions. */
  readonly size: Size
  /** Stacking order / z-index on the Home desktop. */
  readonly zOrder: number
  /** User or subsystem configuration. */
  readonly configuration: Record<string, unknown>
  /** Widget-specific persistent runtime state (e.g. note content). */
  readonly state: Record<string, unknown>
  /** Active lifecycle state. */
  readonly lifecycle: WidgetInstanceLifecycle
  /** Convenient boolean indicating whether the widget is suspended due to monitor detachment. */
  readonly suspended?: boolean | undefined
  /** Creation epoch timestamp in milliseconds. */
  readonly createdAt: number
  /** Last update epoch timestamp in milliseconds. */
  readonly updatedAt: number
}

/** Options for creating a new widget instance. */
export interface CreateWidgetInstanceOptions {
  /** Optional custom instance ID. If omitted, a unique ID is generated. */
  readonly id?: string | undefined
  /** Optional claiming owner ID. Must match definition ownerId if specified. */
  readonly ownerId?: string | undefined
  /** Registered widget definition ID to instantiate. */
  readonly definitionId: string
  /** Target monitor ID where the widget should reside. */
  readonly monitorId: string
  /** Canonical physical coordinates. */
  readonly position: Position
  /** Custom initial size. Defaults to definition.defaultSize. */
  readonly size?: Size | undefined
  /** Initial configuration overrides. */
  readonly configuration?: Record<string, unknown> | undefined
  /** Initial state overrides. */
  readonly state?: Record<string, unknown> | undefined
  /** Initial zOrder. If omitted, assigned to top of stack. */
  readonly zOrder?: number | undefined
}

/** Properties that can be updated on an active widget instance. */
export interface UpdateWidgetInstancePatch {
  readonly position?: Position | undefined
  readonly size?: Size | undefined
  readonly monitorId?: string | undefined
  readonly zOrder?: number | undefined
  readonly configuration?: Record<string, unknown> | undefined
  readonly state?: Record<string, unknown> | undefined
  readonly lifecycle?: WidgetInstanceLifecycle | undefined
  readonly suspended?: boolean | undefined
}

/** Props passed to a component renderer when rendering a widget's visual contents. */
export interface WidgetRenderProps {
  readonly instance: WidgetInstance
  readonly definition: WidgetDefinition
  readonly scaleFactor: number
}

/** Function rendering the visual inner HTML of a registered widget component. */
export type WidgetComponentRenderer = (props: WidgetRenderProps) => string

/** Handler processing widget-specific interaction intents (e.g. user actions). */
export type WidgetIntentHandler = (
  instance: WidgetInstance,
  action: string,
  payload: unknown,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void

/** Event emitted when a widget definition is registered. */
export interface WidgetDefinitionRegisteredEvent {
  readonly definition: WidgetDefinition
}

/** Event emitted when a widget definition is removed. */
export interface WidgetDefinitionRemovedEvent {
  readonly definitionId: string
  readonly ownerId: string
}

/** Event emitted when a widget instance is created. */
export interface WidgetInstanceCreatedEvent {
  readonly instance: WidgetInstance
}

/** Event emitted when a widget instance geometry, monitor, or configuration is updated. */
export interface WidgetInstanceUpdatedEvent {
  readonly instance: WidgetInstance
  readonly patch: UpdateWidgetInstancePatch
}

/** Event emitted when a widget instance is removed. */
export interface WidgetInstanceRemovedEvent {
  readonly instanceId: string
  readonly definitionId: string
  readonly monitorId: string
}

/** Event emitted when a widget instance's state is modified. */
export interface WidgetInstanceStateChangedEvent {
  readonly instance: WidgetInstance
  readonly state: Record<string, unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    widgets: WidgetService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Widget Runtime service. */
    'widgets/ready'(service: WidgetService): void
    /** @mode broadcast @param event Registered widget definition event. */
    'widgets/definition-registered'(event: WidgetDefinitionRegisteredEvent): void
    /** @mode broadcast @param event Removed widget definition event. */
    'widgets/definition-removed'(event: WidgetDefinitionRemovedEvent): void
    /** @mode broadcast @param event Newly created widget instance. */
    'widgets/instance-created'(event: WidgetInstanceCreatedEvent): void
    /** @mode broadcast @param event Updated widget instance. */
    'widgets/instance-updated'(event: WidgetInstanceUpdatedEvent): void
    /** @mode broadcast @param event Removed widget instance. */
    'widgets/instance-removed'(event: WidgetInstanceRemovedEvent): void
    /** @mode broadcast @param event State changed widget instance. */
    'widgets/instance-state-changed'(event: WidgetInstanceStateChangedEvent): void
  }
}
