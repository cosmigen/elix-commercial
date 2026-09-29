import { describe, expect, it } from 'vitest'
import { DefaultShellIconResolver } from '../src/icons.ts'

describe('ShellIconResolver', () => {
  it('resolves direct file icon for image files', () => {
    const resolver = new DefaultShellIconResolver()
    const icon = resolver.resolveReference('file', 'C:/Users/Photo.png', '.png')

    expect(icon.kind).toBe('file')
    if (icon.kind === 'file') {
      expect(icon.filePath).toBe('C:/Users/Photo.png')
    }
  })

  it('resolves PE resource reference for executables', () => {
    const resolver = new DefaultShellIconResolver()
    const icon = resolver.resolveReference('file', 'C:/Windows/notepad.exe', '.exe')

    expect(icon.kind).toBe('resource')
    if (icon.kind === 'resource') {
      expect(icon.sourcePath).toBe('C:/Windows/notepad.exe')
      expect(icon.resourceIndex).toBe(0)
    }
  })

  it('resolves fallback folder icon for directories', () => {
    const resolver = new DefaultShellIconResolver()
    const icon = resolver.resolveReference('folder', 'C:/Users/Documents')

    expect(icon.kind).toBe('fallback')
    if (icon.kind === 'fallback') {
      expect(icon.defaultIconId).toBe('generic-folder')
    }
  })

  it('resolves extension reference for common documents', () => {
    const resolver = new DefaultShellIconResolver()
    const icon = resolver.resolveReference('file', 'C:/Report.pdf', '.pdf')

    expect(icon.kind).toBe('extension')
    if (icon.kind === 'extension') {
      expect(icon.extension).toBe('.pdf')
    }
  })

  it('preserves explicit shortcut icon when provided', () => {
    const resolver = new DefaultShellIconResolver()
    const explicitIcon = {
      kind: 'resource' as const,
      sourcePath: 'C:/Custom/Icon.dll',
      resourceIndex: 2,
    }
    const icon = resolver.resolveReference(
      'shortcut',
      'C:/Link.lnk',
      '.lnk',
      { icon: explicitIcon },
    )

    expect(icon).toEqual(explicitIcon)
  })

  it('inherits executable resource icon for shortcut pointing to an .exe without custom icon', () => {
    const resolver = new DefaultShellIconResolver()
    const icon = resolver.resolveReference(
      'shortcut',
      'C:/Desktop/App.lnk',
      '.lnk',
      { target: 'C:/Program Files/App/app.exe' },
    )
    expect(icon.kind).toBe('resource')
    if (icon.kind === 'resource') {
      expect(icon.sourcePath).toBe('C:/Program Files/App/app.exe')
      expect(icon.resourceIndex).toBe(0)
    }
  })
})
