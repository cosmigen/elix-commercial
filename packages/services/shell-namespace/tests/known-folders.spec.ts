import { describe, expect, it } from 'vitest'
import {
  expandEnvironmentStrings,
  parseRegQueryOutput,
  WindowsKnownFolderResolver,
  InMemoryKnownFolderResolver,
} from '../src/known-folders.ts'

describe('KnownFolderResolver', () => {
  it('expands environment variables in registry values', () => {
    process.env.TEST_FOO = 'BarValue'
    const expanded = expandEnvironmentStrings('%TEST_FOO%\\Subfolder')
    expect(expanded).toBe('BarValue\\Subfolder')
  })

  it('parses reg query output correctly', () => {
    const mockOutput = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    Desktop    REG_EXPAND_SZ    C:\\Users\\User\\OneDrive\\Desktop
    Personal    REG_SZ    C:\\Users\\User\\Documents
`
    const parsed = parseRegQueryOutput(mockOutput)
    expect(parsed.get('Desktop')).toBe('C:\\Users\\User\\OneDrive\\Desktop')
    expect(parsed.get('Personal')).toBe('C:\\Users\\User\\Documents')
  })

  it('resolves virtual RecycleBin without a physical path', async () => {
    const resolver = new InMemoryKnownFolderResolver()
    const recycleBin = await resolver.resolve('RecycleBin')

    expect(recycleBin.id).toBe('RecycleBin')
    expect(recycleBin.isVirtual).toBe(true)
    expect(recycleBin.path).toBeUndefined()
    expect(recycleBin.available).toBe(true)
  })

  it('resolves custom redirected Known Folders via adapter', async () => {
    const customDesktopPath = 'D:/CustomRedirectedDesktop'
    const customDocsPath = 'E:/CompanyStorage/Documents'

    const resolver = new InMemoryKnownFolderResolver({
      Desktop: customDesktopPath,
      Documents: customDocsPath,
    })

    const desktopRes = await resolver.resolve('Desktop')
    expect(desktopRes.path).toBe(customDesktopPath)
    expect(desktopRes.isVirtual).toBe(false)
    expect(desktopRes.available).toBe(true)

    const docsRes = await resolver.resolve('Documents')
    expect(docsRes.path).toBe(customDocsPath)
  })

  it('resolves all known folders in resolveAll', async () => {
    const resolver = new InMemoryKnownFolderResolver({
      Desktop: 'C:/Users/Test/Desktop',
      PublicDesktop: 'C:/Users/Public/Desktop',
      Downloads: 'C:/Users/Test/Downloads',
    })

    const all = await resolver.resolveAll()
    expect(all.has('Desktop')).toBe(true)
    expect(all.has('PublicDesktop')).toBe(true)
    expect(all.has('Downloads')).toBe(true)
    expect(all.has('RecycleBin')).toBe(true)
  })

  it('queries real Windows Known Folders without throwing', async () => {
    const resolver = new WindowsKnownFolderResolver()
    const desktop = await resolver.resolve('Desktop')
    expect(desktop.id).toBe('Desktop')
    expect(desktop.path).toBeDefined()
    expect(typeof desktop.path).toBe('string')

    const publicDesktop = await resolver.resolve('PublicDesktop')
    expect(publicDesktop.id).toBe('PublicDesktop')
    expect(publicDesktop.path).toBeDefined()
  })
})
