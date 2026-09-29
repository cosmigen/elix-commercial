import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WidgetService } from '../src/service.ts'

describe('Built-in Demonstration Widgets (Clock, Calendar, Notes)', () => {
  it('registers Clock, Calendar, and Notes definitions on initialization', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    expect(service.hasDefinition('clock')).toBe(true)
    expect(service.hasDefinition('calendar')).toBe(true)
    expect(service.hasDefinition('notes')).toBe(true)

    const clock = service.getDefinition('clock')!
    expect(clock.title).toBe('Clock')
    expect(clock.resizable).toBe(true)
    expect(clock.defaultSize).toEqual({ width: 260, height: 120 })

    const calendar = service.getDefinition('calendar')!
    expect(calendar.title).toBe('Calendar')
    expect(calendar.resizable).toBe(true)

    const notes = service.getDefinition('notes')!
    expect(notes.title).toBe('Notes')
    expect(notes.resizable).toBe(true)
  })

  it('renders Clock widget inner HTML with time and date', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const inst = service.create({
      definitionId: 'clock',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
    })

    const html = service.renderWidget(inst)
    expect(html).toContain('data-widget-clock="true"')
    expect(html).toContain('class="clock-display"')
    expect(html).toContain('class="clock-time"')
    expect(html).toContain('class="clock-date"')
  })

  it('renders Calendar widget inner HTML with month and day grid', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const inst = service.create({
      definitionId: 'calendar',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
    })

    const html = service.renderWidget(inst)
    expect(html).toContain('calendar-display')
    expect(html).toContain('calendar-header')
    expect(html).toContain('calendar-grid')
    expect(html).toContain('is-today')
  })

  it('renders Notes widget and handles updateText intent to persist state', async () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const inst = service.create({
      definitionId: 'notes',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
      state: { text: 'Initial note text' },
    })

    // Initial render includes existing note text
    const html1 = service.renderWidget(inst)
    expect(html1).toContain('notes-display')
    expect(html1).toContain('Initial note text')

    // Handle user typing intent
    await service.handleIntent(inst.id, 'updateText', { text: 'Updated ELIX Phase 12 note!' })

    const updated = service.get(inst.id)
    expect(updated?.state.text).toBe('Updated ELIX Phase 12 note!')

    // Subsequent render reflects new note text
    const html2 = service.renderWidget(updated!)
    expect(html2).toContain('Updated ELIX Phase 12 note!')
  })
})
