/**
 * Authoritative Declarative Widget Renderer Registry for ELIX Widget Runtime.
 *
 * Manages trusted component renderers and interactive intent handlers,
 * preventing arbitrary string eval while allowing dynamic pluggable widget visual components.
 *
 * @module @deepseek-ai/dsh-shell-widgets/renderer-registry
 */

import type {
  WidgetComponentRenderer,
  WidgetDefinition,
  WidgetInstance,
  WidgetIntentHandler,
} from './types.ts'

/**
 * Registry storing declarative component renderers and intent handlers.
 */
export class WidgetRendererRegistry {
  private readonly renderers = new Map<string, WidgetComponentRenderer>()
  private readonly intentHandlers = new Map<string, WidgetIntentHandler>()

  /**
   * Register a trusted component renderer and optional interaction intent handler.
   *
   * @param componentName - Identifier matching WidgetRendererSpec componentName.
   * @param renderer - Pure function generating inner HTML markup.
   * @param intentHandler - Optional handler for interactive actions.
   * @returns Disposer function.
   */
  registerComponent(
    componentName: string,
    renderer: WidgetComponentRenderer,
    intentHandler?: WidgetIntentHandler,
  ): () => void {
    this.renderers.set(componentName, renderer)
    if (intentHandler !== undefined) {
      this.intentHandlers.set(componentName, intentHandler)
    }

    return () => {
      this.renderers.delete(componentName)
      if (intentHandler !== undefined) {
        this.intentHandlers.delete(componentName)
      }
    }
  }

  /**
   * Render the inner HTML content of a widget instance.
   */
  render(instance: WidgetInstance, definition: WidgetDefinition, scaleFactor = 1): string {
    if (definition.renderer.type === 'html') {
      return definition.renderer.html
    }

    const renderer = this.renderers.get(definition.renderer.componentName)
    if (renderer !== undefined) {
      try {
        return renderer({ instance, definition, scaleFactor })
      } catch (error) {
        console.error(`Error rendering widget component "${definition.renderer.componentName}":`, error)
        return '<div class="widget-render-error">Render Error</div>'
      }
    }

    return `<div class="widget-fallback-content"><span>${escapeHtml(definition.title)}</span></div>`
  }

  /**
   * Handle an interactive intent action directed at a widget instance.
   */
  async handleIntent(
    instance: WidgetInstance,
    definition: WidgetDefinition,
    action: string,
    payload: unknown,
  ): Promise<Record<string, unknown> | void> {
    if (definition.renderer.type === 'component') {
      const handler = this.intentHandlers.get(definition.renderer.componentName)
      if (handler !== undefined) {
        return handler(instance, action, payload)
      }
    }
    return undefined
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
