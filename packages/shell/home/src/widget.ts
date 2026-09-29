/**
 * Widget Adapter and Types for ELIX Home Screen.
 *
 * All authoritative widget definitions, instances, lifecycle, and runtime
 * are owned exclusively by the Widget Runtime service (`ctx.widgets`).
 * Home serves as a generic projection consumer and WebView renderer.
 *
 * @module @deepseek-ai/dsh-home/widget
 */

import type { WidgetDefinition } from '@deepseek-ai/dsh-shell-widgets'

export type {
  CreateWidgetInstanceOptions,
  UpdateWidgetInstancePatch,
  WidgetComponentRenderer,
  WidgetDefinition,
  WidgetInstance,
  WidgetInstanceLifecycle,
  WidgetIntentHandler,
} from '@deepseek-ai/dsh-shell-widgets'

/** Grid size unit in logical desktop columns and rows. */
export interface GridSpan {
  readonly w: number
  readonly h: number
}

/**
 * Convert desktop grid spans (columns x rows) to physical pixel dimensions.
 *
 * @param span - Column and row span count.
 * @param cellWidth - Width of a single grid cell in physical pixels.
 * @param cellHeight - Height of a single grid cell in physical pixels.
 * @returns Physical pixel Size.
 */
export function gridSpanToSize(
  span: GridSpan,
  cellWidth = 86,
  cellHeight = 72,
): { width: number; height: number } {
  return {
    width: span.w * cellWidth,
    height: span.h * cellHeight,
  }
}

/**
 * Convert physical pixel dimensions to discrete desktop grid spans.
 *
 * @param size - Physical pixel dimensions.
 * @param cellWidth - Width of a single grid cell in physical pixels.
 * @param cellHeight - Height of a single grid cell in physical pixels.
 * @returns Discrete GridSpan.
 */
export function sizeToGridSpan(
  size: { width: number; height: number },
  cellWidth = 86,
  cellHeight = 72,
): GridSpan {
  return {
    w: Math.max(1, Math.round(size.width / cellWidth)),
    h: Math.max(1, Math.round(size.height / cellHeight)),
  }
}

/**
 * Convert an Old ELIX or external widget manifest (e.g. ElixWidgetManifestV1)
 * into an authoritative WidgetDefinition compatible with ctx.widgets.
 *
 * @param manifest - Manifest dictionary.
 * @returns Authoritative WidgetDefinition.
 */
export function widgetDefinitionFromManifest(manifest: Record<string, unknown>): WidgetDefinition {
  const id = typeof manifest.id === 'string' ? manifest.id : `widget-${Date.now().toString(36)}`
  const title = typeof manifest.name === 'string'
    ? manifest.name
    : (typeof manifest.title === 'string' ? manifest.title : id)
  const version = typeof manifest.version === 'string' ? manifest.version : '1.0.0'
  const ownerId = typeof manifest.ownerId === 'string' ? manifest.ownerId : 'elix.custom'

  const minLayout = manifest.minimumSize as { w?: number; h?: number } | undefined
  const defLayout = manifest.defaultLayout as { w?: number; h?: number } | undefined

  const minGridSize: GridSpan = {
    w: Math.max(1, typeof minLayout?.w === 'number' ? minLayout.w : 2),
    h: Math.max(1, typeof minLayout?.h === 'number' ? minLayout.h : 2),
  }

  const defaultGridSize: GridSpan = {
    w: Math.max(minGridSize.w, typeof defLayout?.w === 'number' ? defLayout.w : 3),
    h: Math.max(minGridSize.h, typeof defLayout?.h === 'number' ? defLayout.h : 2),
  }

  const memory = manifest.memory as { defaultValue?: Record<string, unknown> } | undefined
  const defaultConfig = (memory?.defaultValue !== undefined && typeof memory.defaultValue === 'object')
    ? memory.defaultValue
    : {}

  return {
    id,
    ownerId,
    title,
    version,
    defaultSize: gridSpanToSize(defaultGridSize),
    minSize: gridSpanToSize(minGridSize),
    defaultConfig,
    renderer: {
      type: 'component',
      componentName: id,
    },
  }
}

export const fromManifest = widgetDefinitionFromManifest
