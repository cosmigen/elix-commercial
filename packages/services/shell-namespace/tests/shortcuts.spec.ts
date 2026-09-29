import { describe, expect, it } from 'vitest'
import {
  DefaultShellLinkResolver,
  MockShellLinkResolver,
  parseArgumentsString,
} from '../src/shortcuts.ts'

describe('ShellLinkResolver', () => {
  it('parses argument strings with quotes and flags', () => {
    const raw = '--profile "My Profile" -v --dir "C:\\Program Files\\App"'
    const parsed = parseArgumentsString(raw)

    expect(parsed).toBeDefined()
    expect(parsed).toEqual([
      '--profile',
      'My Profile',
      '-v',
      '--dir',
      'C:\\Program Files\\App',
    ])
  })

  it('returns undefined for empty argument strings', () => {
    expect(parseArgumentsString('')).toBeUndefined()
    expect(parseArgumentsString('   ')).toBeUndefined()
    expect(parseArgumentsString(null)).toBeUndefined()
  })

  it('resolves shortcuts via MockShellLinkResolver', async () => {
    const resolver = new MockShellLinkResolver({
      'C:/Users/Desktop/VSCode.lnk': {
        target: 'C:/Program Files/VSCode/Code.exe',
        arguments: ['--new-window'],
        workingDirectory: 'C:/Projects',
        description: 'Visual Studio Code',
        isBroken: false,
      },
      'C:/Users/Desktop/BrokenApp.lnk': {
        target: 'C:/DeletedDirectory/OldApp.exe',
        isBroken: true,
      },
    })

    const vscode = await resolver.resolve('C:/Users/Desktop/VSCode.lnk')
    expect(vscode).toBeDefined()
    expect(vscode?.target).toBe('C:/Program Files/VSCode/Code.exe')
    expect(vscode?.isBroken).toBe(false)
    expect(vscode?.arguments).toEqual(['--new-window'])

    const broken = await resolver.resolve('C:/Users/Desktop/BrokenApp.lnk')
    expect(broken).toBeDefined()
    expect(broken?.isBroken).toBe(true)
  })

  it('batch resolves multiple shortcuts in a single map', async () => {
    const resolver = new MockShellLinkResolver({
      'C:/Lnk1.lnk': { target: 'C:/Target1.exe', isBroken: false },
      'C:/Lnk2.lnk': { target: 'C:/Target2.exe', isBroken: false },
    })

    const batch = await resolver.resolveBatch(['C:/Lnk1.lnk', 'C:/Lnk2.lnk'])
    expect(batch.size).toBe(2)
  })

  it('clears cache in DefaultShellLinkResolver', () => {
    const resolver = new DefaultShellLinkResolver()
    expect(() => {
      resolver.clearCache()
    }).not.toThrow()
  })
})
