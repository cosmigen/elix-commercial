import { describe, expect, it } from 'vitest'
import { HomeInteractionManager } from '../src/interaction.ts'
import { HomeSelectionManager } from '../src/selection.ts'
import type { ContextMenuRequest } from '../src/types.ts'
import type { HomeItem } from '../src/items.ts'

describe('HomeSelectionManager', () => {
  it('handles single and multi-selection modes', () => {
    const manager = new HomeSelectionManager()
    expect(manager.getSelectedIds()).toEqual([])

    // Single select replaces existing selection
    manager.select('item-1')
    expect(manager.getSelectedIds()).toEqual(['item-1'])
    expect(manager.isSelected('item-1')).toBe(true)

    manager.select('item-2')
    expect(manager.getSelectedIds()).toEqual(['item-2'])
    expect(manager.isSelected('item-1')).toBe(false)
    expect(manager.isSelected('item-2')).toBe(true)

    // Multi-select with append=true
    manager.select('item-3', true)
    expect(manager.getSelectedCount()).toBe(2)
    expect(manager.isSelected('item-2')).toBe(true)
    expect(manager.isSelected('item-3')).toBe(true)
  })

  it('toggles item selection state', () => {
    const manager = new HomeSelectionManager()
    manager.select('item-a')

    manager.toggle('item-a')
    expect(manager.isSelected('item-a')).toBe(false)
    expect(manager.getSelectedCount()).toBe(0)

    manager.toggle('item-a')
    expect(manager.isSelected('item-a')).toBe(true)
  })

  it('selects all given ids and clears selection', () => {
    const manager = new HomeSelectionManager()
    manager.selectAll(['a', 'b', 'c'])
    expect(manager.getSelectedCount()).toBe(3)
    expect(manager.getSelectedIds()).toEqual(['a', 'b', 'c'])

    manager.clear()
    expect(manager.getSelectedCount()).toBe(0)
    expect(manager.getSelectedIds()).toEqual([])
  })

  it('calculates rubber-band / marquee box intersections', () => {
    const manager = new HomeSelectionManager()

    const items: HomeItem[] = [
      {
        id: 'item-1',
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 50, y: 50 },
        size: { width: 50, height: 50 },
        metadata: { name: 'Item 1', icon: '', target: '' },
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'item-2',
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 200, y: 200 },
        size: { width: 50, height: 50 },
        metadata: { name: 'Item 2', icon: '', target: '' },
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'item-3',
        type: 'file',
        monitorId: 'mon-1',
        position: { x: 70, y: 70 },
        size: { width: 30, height: 30 },
        metadata: { filename: 'file.txt', path: '', extension: 'txt' },
        createdAt: 0,
        updatedAt: 0,
      },
    ]

    // Rubber band covering (0, 0) to (120, 120) -> should intersect item-1 and item-3
    const selected = manager.selectInRect({ x: 0, y: 0, width: 120, height: 120 }, items)
    expect(selected).toEqual(['item-1', 'item-3'])
    expect(manager.isSelected('item-1')).toBe(true)
    expect(manager.isSelected('item-2')).toBe(false)
    expect(manager.isSelected('item-3')).toBe(true)
  })

  it('notifies listeners on selection changes', () => {
    const manager = new HomeSelectionManager()
    const history: (readonly string[])[] = []

    const unbind = manager.onSelectionChange((ids) => {
      history.push(ids)
    })

    manager.select('x')
    manager.select('y', true)
    manager.clear()

    expect(history).toEqual([['x'], ['x', 'y'], []])
    unbind()

    manager.select('z')
    expect(history).toHaveLength(3)
  })
})

describe('HomeInteractionManager', () => {
  it('dispatches context-menu requests to listeners', () => {
    const interaction = new HomeInteractionManager()
    const received: ContextMenuRequest[] = []

    const unbind = interaction.onContextMenuRequest((req) => {
      received.push(req)
    })

    interaction.requestContextMenu({
      targetType: 'desktop',
      position: { x: 500, y: 300 },
      monitorId: 'mon-1',
    })

    interaction.requestContextMenu({
      targetType: 'item',
      targetId: 'doc-1',
      position: { x: 120, y: 150 },
      monitorId: 'mon-1',
    })

    expect(received).toHaveLength(2)
    expect(received[0]?.targetType).toBe('desktop')
    expect(received[1]?.targetType).toBe('item')
    expect(received[1]?.targetId).toBe('doc-1')

    unbind()
    interaction.requestContextMenu({
      targetType: 'folder',
      targetId: 'folder-1',
      position: { x: 200, y: 200 },
      monitorId: 'mon-1',
    })
    expect(received).toHaveLength(2)
  })
})
