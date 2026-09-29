import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IntentRouterEngine } from '../src/index.ts'
import {
  InvalidInputError,
  validateAppId,
  validateFolderRelationship,
  validateItemName,
  validatePathSafety,
  validateShellItemId,
} from '../src/validation.ts'

describe('IntentRouter Security Validation & Host Invariants', () => {
  describe('Path Traversal & Absolute Path Enforcement', () => {
    it('rejects relative and unnormalized paths', () => {
      expect(() => validatePathSafety('relative/path.txt')).toThrow(InvalidInputError)
      expect(() => validatePathSafety('../secret.txt')).toThrow(InvalidInputError)
      expect(() => validatePathSafety('.')).toThrow(InvalidInputError)
      expect(() => validatePathSafety('..')).toThrow(InvalidInputError)
    })

    it('rejects path traversal sequences embedded inside paths', () => {
      expect(() => validatePathSafety('C:\\Users\\Public\\..\\..\\Windows\\System32\\cmd.exe')).toThrow(InvalidInputError)
      expect(() => validatePathSafety('C:/Users/Public/../../Windows/System32')).toThrow(InvalidInputError)
    })

    it('rejects paths containing null bytes or control characters', () => {
      expect(() => validatePathSafety('C:\\Valid\\Path\0malicious')).toThrow(InvalidInputError)
      expect(() => validatePathSafety('C:\\Valid\\Path\x08bell')).toThrow(InvalidInputError)
      expect(() => validatePathSafety('C:\\Valid\\Path\x1F')).toThrow(InvalidInputError)
    })

    it('accepts safe absolute Windows drive and UNC paths', () => {
      expect(validatePathSafety('C:\\Users\\User\\Documents\\file.txt')).toBe('C:\\Users\\User\\Documents\\file.txt')
      expect(validatePathSafety('\\\\server\\share\\folder\\file.txt')).toBe('\\\\server\\share\\folder\\file.txt')
    })
  })

  describe('Windows Reserved DOS Device Names', () => {
    const reservedBases = [
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ]

    it('rejects exact reserved device names (case-insensitive)', () => {
      for (const name of reservedBases) {
        expect(() => validateItemName(name)).toThrow(InvalidInputError)
        expect(() => validateItemName(name.toLowerCase())).toThrow(InvalidInputError)
      }
    })

    it('rejects reserved device names with file extensions', () => {
      for (const name of reservedBases) {
        expect(() => validateItemName(`${name}.txt`)).toThrow(InvalidInputError)
        expect(() => validateItemName(`${name.toLowerCase()}.tar.gz`)).toThrow(InvalidInputError)
        expect(() => validateItemName(`${name}.log`)).toThrow(InvalidInputError)
      }
    })
  })

  describe('Illegal Filename Characters & Formatting', () => {
    it('rejects characters forbidden by Windows NT filesystem', () => {
      const illegalChars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']
      for (const char of illegalChars) {
        expect(() => validateItemName(`test${char}file.txt`)).toThrow(InvalidInputError)
      }
    })

    it('rejects trailing dots and spaces that break Win32 path normalization', () => {
      expect(() => validateItemName('filename.')).toThrow(InvalidInputError)
      expect(() => validateItemName('filename..')).toThrow(InvalidInputError)
      expect(() => validateItemName('filename ')).toThrow(InvalidInputError)
      expect(() => validateItemName('filename   ')).toThrow(InvalidInputError)
    })

    it('rejects filenames exceeding maximum permitted 255 character length', () => {
      const tooLong = 'a'.repeat(256)
      expect(() => validateItemName(tooLong)).toThrow(InvalidInputError)
    })
  })

  describe('Identifier Sanitization & Length Bounds', () => {
    it('rejects malformed or empty ShellItemIds', () => {
      expect(() => validateShellItemId('')).toThrow(InvalidInputError)
      expect(() => validateShellItemId('   ')).toThrow(InvalidInputError)
      expect(() => validateShellItemId(null)).toThrow(InvalidInputError)
      expect(() => validateShellItemId(123)).toThrow(InvalidInputError)
    })

    it('rejects path traversal or control characters in ShellItemIds', () => {
      expect(() => validateShellItemId('item:../../root')).toThrow(InvalidInputError)
      expect(() => validateShellItemId('item:\x00evil')).toThrow(InvalidInputError)
    })

    it('rejects ShellItemIds exceeding 512 characters', () => {
      const longId = 'id:' + 'x'.repeat(512)
      expect(() => validateShellItemId(longId)).toThrow(InvalidInputError)
    })

    it('rejects malformed or empty AppIds', () => {
      expect(() => validateAppId('')).toThrow(InvalidInputError)
      expect(() => validateAppId('   ')).toThrow(InvalidInputError)
      expect(() => validateAppId(undefined)).toThrow(InvalidInputError)
      expect(() => validateAppId({})).toThrow(InvalidInputError)
    })

    it('rejects AppIds exceeding 256 characters', () => {
      const longId = 'app:' + 'y'.repeat(256)
      expect(() => validateAppId(longId)).toThrow(InvalidInputError)
    })
  })

  describe('Directory Relationship & Recursive Loop Protection', () => {
    it('rejects operating a folder into its own identical path', () => {
      const folder = path.resolve('C:\\Data\\Projects')
      expect(() => {
        validateFolderRelationship(folder, folder)
      }).toThrow(InvalidInputError)
      expect(() => {
        validateFolderRelationship(folder, folder.toLowerCase())
      }).toThrow(InvalidInputError)
    })

    it('rejects operating a folder into one of its direct subdirectories', () => {
      const source = path.resolve('C:\\Data\\Projects')
      const dest = path.resolve('C:\\Data\\Projects\\Web')
      expect(() => {
        validateFolderRelationship(source, dest)
      }).toThrow(InvalidInputError)
    })

    it('rejects operating a folder into a deep descendant', () => {
      const source = path.resolve('C:\\Data\\Projects')
      const dest = path.resolve('C:\\Data\\Projects\\Web\\src\\components\\deep')
      expect(() => {
        validateFolderRelationship(source, dest)
      }).toThrow(InvalidInputError)
    })

    it('permits operating a folder into an unrelated peer or ancestor', () => {
      const source = path.resolve('C:\\Data\\Projects\\Web')
      const peer = path.resolve('C:\\Data\\Archives')
      const ancestor = path.resolve('C:\\Data')

      expect(() => {
        validateFolderRelationship(source, peer)
      }).not.toThrow()
      expect(() => {
        validateFolderRelationship(source, ancestor)
      }).not.toThrow()
    })
  })

  describe('Intent Router Attack Vectors & Untrusted Boundary Rejection', () => {
    const engine = new IntentRouterEngine({
      preferNative: false,
      processLauncher: {
        launchWin32: vi.fn().mockResolvedValue({ success: true, pid: 100 }),
      },
    })

    it('rejects arbitrary local executable path attempts through open-app', async () => {
      const paths = [
        'C:\\Windows\\System32\\cmd.exe',
        'C:/Windows/System32/powershell.exe',
        'powershell.exe',
        'cmd.exe',
        'malware.bat',
        'script.ps1',
      ]
      for (const p of paths) {
        const res = await engine.dispatch({ type: 'open-app', appId: p })
        expect(res.status).toBe('invalid-request')
        expect(res.error?.code).toBe('INVALID_APP_ID')
      }
    })

    it('rejects raw local filesystem path injection through open-file', async () => {
      const paths = [
        'C:\\Windows\\System32\\cmd.exe',
        '/bin/sh',
        'C:/sensitive/file.txt',
        'D:\\secret.doc',
      ]
      for (const p of paths) {
        const res = await engine.dispatch({ type: 'open-file', itemId: p })
        expect(res.status).toBe('invalid-request')
        expect(res.error?.code).toBe('INVALID_ITEM_ID')
      }
    })

    it('rejects command injection attempts through appId, itemId, and item names', async () => {
      const commandInjections = [
        'calc.exe & dir',
        'calc.exe | whoami',
        'app;echo hacked',
        'app`dir`',
        'app$HOME',
      ]
      for (const payload of commandInjections) {
        const res = await engine.dispatch({ type: 'open-app', appId: payload })
        expect(res.status).toBe('invalid-request')
      }

      const itemInjections = [
        'file:doc & calc.exe',
        'file:doc;rmdir /s /q C:\\',
        'file:doc|whoami',
      ]
      for (const payload of itemInjections) {
        const res = await engine.dispatch({ type: 'open-file', itemId: payload })
        expect(res.status).toBe('invalid-request')
      }

      const renameInjections = [
        'name | echo',
        'name < test',
        'name > out.txt',
      ]
      for (const payload of renameInjections) {
        const res = await engine.dispatch({ type: 'rename', itemId: 'file:safe', newName: payload })
        expect(res.status).toBe('invalid-request')
      }
    })

    it('returns typed not-found for forged or stale renderer item identifiers', async () => {
      const forgedIds = ['forged:item:999', 'stale:id:42', 'nonexistent:file']
      for (const id of forgedIds) {
        const res = await engine.dispatch({ type: 'open-file', itemId: id })
        expect(res.status).toBe('not-found')
        expect(res.error?.code).toBe('NOT_FOUND')
      }
    })

    it('rejects unsupported or forged intent types from untrusted callers', async () => {
      const malformed = [
        { type: 'exec-shell', command: 'whoami' },
        { type: 'delete-all' },
        { type: '' },
        null,
        123,
      ]
      for (const payload of malformed) {
        const res = await engine.dispatch(payload)
        expect(res.status).toBe('invalid-request')
      }
    })
  })
})
