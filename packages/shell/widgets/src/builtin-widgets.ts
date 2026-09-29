/**
 * Standard Built-In Acceptance Widgets for ELIX Widget Runtime.
 *
 * Provides Clock, Calendar, and Notes widgets to prove registration,
 * creation, geometry, persistence, resizing, and renderer updates.
 *
 * @module @deepseek-ai/dsh-shell-widgets/builtin-widgets
 */

import type {
  WidgetComponentRenderer,
  WidgetDefinition,
  WidgetIntentHandler,
  WidgetRenderProps,
} from './types.ts'

export const BUILTIN_OWNER_ID = 'elix.builtin'

/**
 * Clock Widget Definition.
 */
export const CLOCK_WIDGET_DEFINITION: WidgetDefinition = {
  id: 'clock',
  ownerId: BUILTIN_OWNER_ID,
  title: 'Clock',
  description: 'Minimalist live digital clock and date display',
  version: '1.0.0',
  defaultSize: { width: 260, height: 120 },
  minSize: { width: 180, height: 90 },
  maxSize: { width: 440, height: 240 },
  resizable: true,
  defaultConfig: { format24h: false },
  defaultState: {},
  renderer: {
    type: 'component',
    componentName: 'clock',
  },
}

/**
 * Calendar Widget Definition.
 */
export const CALENDAR_WIDGET_DEFINITION: WidgetDefinition = {
  id: 'calendar',
  ownerId: BUILTIN_OWNER_ID,
  title: 'Calendar',
  description: 'Monthly calendar grid with current date highlight',
  version: '1.0.0',
  defaultSize: { width: 280, height: 240 },
  minSize: { width: 240, height: 200 },
  maxSize: { width: 440, height: 380 },
  resizable: true,
  defaultConfig: {},
  defaultState: {},
  renderer: {
    type: 'component',
    componentName: 'calendar',
  },
}

/**
 * Notes Widget Definition.
 */
export const NOTES_WIDGET_DEFINITION: WidgetDefinition = {
  id: 'notes',
  ownerId: BUILTIN_OWNER_ID,
  title: 'Notes',
  description: 'Persistent desktop scratchpad',
  version: '1.0.0',
  defaultSize: { width: 260, height: 200 },
  minSize: { width: 200, height: 150 },
  maxSize: { width: 520, height: 420 },
  resizable: true,
  defaultConfig: {},
  defaultState: { text: '' },
  renderer: {
    type: 'component',
    componentName: 'notes',
  },
}

export const BUILTIN_DEFINITIONS: readonly WidgetDefinition[] = [
  CLOCK_WIDGET_DEFINITION,
  CALENDAR_WIDGET_DEFINITION,
  NOTES_WIDGET_DEFINITION,
]

/**
 * Pure component renderer for Clock widget.
 */
export const renderClockWidget: WidgetComponentRenderer = ({ instance }: WidgetRenderProps): string => {
  const now = new Date()
  const format24h = Boolean(instance.configuration.format24h)
  const hours = now.getHours()
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')

  let timeStr: string
  let ampm = ''
  if (format24h) {
    timeStr = `${String(hours).padStart(2, '0')}:${minutes}:${seconds}`
  } else {
    const h12 = hours % 12 || 12
    ampm = hours >= 12 ? 'PM' : 'AM'
    timeStr = `${h12}:${minutes}:${seconds}`
  }

  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  return `
    <div class="clock-display" data-widget-clock="true">
      <div class="clock-time">
        <span>${escapeHtml(timeStr)}</span>
        ${ampm ? `<span class="clock-ampm">${ampm}</span>` : ''}
      </div>
      <div class="clock-date">${escapeHtml(dateStr)}</div>
    </div>
  `.trim()
}

/**
 * Pure component renderer for Calendar widget.
 */
export const renderCalendarWidget: WidgetComponentRenderer = (): string => {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const today = now.getDate()

  const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const firstDayOfWeek = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const dayHeaders = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
  const headerHtml = dayHeaders.map(d => `<div class="cal-day-header">${d}</div>`).join('')

  const cellItems: string[] = []
  for (let i = 0; i < firstDayOfWeek; i++) {
    cellItems.push('<div class="cal-cell cal-empty"></div>')
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = d === today
    cellItems.push(`<div class="cal-cell ${isToday ? 'is-today' : ''}">${d}</div>`)
  }

  return `
    <div class="calendar-display">
      <div class="calendar-header">${escapeHtml(monthName)}</div>
      <div class="calendar-grid">
        ${headerHtml}
        ${cellItems.join('')}
      </div>
    </div>
  `.trim()
}

/**
 * Pure component renderer for Notes widget.
 */
export const renderNotesWidget: WidgetComponentRenderer = ({ instance }: WidgetRenderProps): string => {
  const text = typeof instance.state.text === 'string' ? instance.state.text : ''
  return `
    <div class="notes-display">
      <textarea
        class="notes-textarea"
        placeholder="Type notes here..."
        data-widget-input="notes"
        data-instance-id="${escapeHtml(instance.id)}"
        spellcheck="false"
      >${escapeHtml(text)}</textarea>
    </div>
  `.trim()
}

/**
 * Intent handler for Notes widget text updates.
 */
export const notesIntentHandler: WidgetIntentHandler = (
  _instance,
  action,
  payload,
): Record<string, unknown> | void => {
  if (action === 'updateText') {
    const obj = payload as { text?: unknown } | undefined
    const text = typeof obj?.text === 'string' ? obj.text : ''
    return { text }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
