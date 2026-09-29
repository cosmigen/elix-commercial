import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileOperationsCoordinator } from '../src/operations.ts'
import { InvalidInputError } from '../src/validation.ts'

describe('FileOperationsCoordinator — File Operations', () => {
  let tmpDir: string
  let coordinator: FileOperationsCoordinator

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-file-ops-test-'))
    coordinator = new FileOperationsCoordinator()
  })

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }
  })

  describe('rename', () => {
    it('successfully renames a file in the same directory', async () => {
      const src = path.join(tmpDir, 'old-name.txt')
      await fs.writeFile(src, 'hello world', 'utf-8')

      const newPath = await coordinator.rename(src, 'new-name.txt')
      expect(newPath).toBe(path.join(tmpDir, 'new-name.txt'))

      // Verify filesystem state
      const content = await fs.readFile(path.join(tmpDir, 'new-name.txt'), 'utf-8')
      expect(content).toBe('hello world')

      // Verify old file is gone
      await expect(fs.stat(src)).rejects.toThrow()
    })

    it('handles rename when new name is identical to current name', async () => {
      const src = path.join(tmpDir, 'same.txt')
      await fs.writeFile(src, 'data', 'utf-8')

      const result = await coordinator.rename(src, 'same.txt')
      expect(result).toBe(src)
    })

    it('rejects rename when target already exists', async () => {
      const src1 = path.join(tmpDir, 'file1.txt')
      const src2 = path.join(tmpDir, 'file2.txt')
      await fs.writeFile(src1, 'one', 'utf-8')
      await fs.writeFile(src2, 'two', 'utf-8')

      await expect(coordinator.rename(src1, 'file2.txt')).rejects.toThrow(InvalidInputError)
    })

    it('rejects rename when target name is a reserved Windows DOS device name', async () => {
      const src = path.join(tmpDir, 'valid.txt')
      await fs.writeFile(src, 'test', 'utf-8')

      await expect(coordinator.rename(src, 'NUL.txt')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'CON')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'prn.log')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'aux')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'com1')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'lpt3.txt')).rejects.toThrow(InvalidInputError)
    })

    it('rejects rename when target name contains illegal Windows filename characters', async () => {
      const src = path.join(tmpDir, 'test.txt')
      await fs.writeFile(src, 'test', 'utf-8')

      await expect(coordinator.rename(src, 'foo:bar')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'bad*name.txt')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'question?mark')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, '<pipe>|')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'trailing.')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.rename(src, 'trailing ')).rejects.toThrow(InvalidInputError)
    })

    it('returns not-found when source file does not exist', async () => {
      const src = path.join(tmpDir, 'missing.txt')
      await expect(coordinator.rename(src, 'new.txt')).rejects.toThrow(InvalidInputError)
    })

    it('handles rename to identical name when path format uses forward slashes', async () => {
      const src = path.join(tmpDir, 'same-name.txt')
      await fs.writeFile(src, 'data', 'utf-8')

      // Use forward-slash formatted source
      const forwardSlashSrc = src.replace(/\\/g, '/')
      const result = await coordinator.rename(forwardSlashSrc, 'same-name.txt')
      expect(path.resolve(result)).toBe(path.resolve(src))
    })
  })

  describe('createFolder', () => {
    it('creates a new folder inside an existing directory', async () => {
      const createdPath = await coordinator.createFolder(tmpDir, 'New Project')
      expect(createdPath).toBe(path.join(tmpDir, 'New Project'))

      const stat = await fs.stat(path.join(tmpDir, 'New Project'))
      expect(stat.isDirectory()).toBe(true)
    })

    it('rejects folder creation if folder already exists', async () => {
      await fs.mkdir(path.join(tmpDir, 'Existing'))

      await expect(coordinator.createFolder(tmpDir, 'Existing')).rejects.toThrow(InvalidInputError)
    })

    it('rejects folder creation if name is a reserved DOS device name', async () => {
      await expect(coordinator.createFolder(tmpDir, 'CON')).rejects.toThrow(InvalidInputError)
      await expect(coordinator.createFolder(tmpDir, 'nul')).rejects.toThrow(InvalidInputError)
    })

    it('rejects folder creation if destination is not a directory', async () => {
      const filePath = path.join(tmpDir, 'not-a-dir.txt')
      await fs.writeFile(filePath, 'hello')

      await expect(coordinator.createFolder(filePath, 'SubFolder')).rejects.toThrow(InvalidInputError)
    })
  })

  describe('move', () => {
    it('moves multiple files into destination directory', async () => {
      const destDir = path.join(tmpDir, 'dest')
      await fs.mkdir(destDir)

      const f1 = path.join(tmpDir, 'file1.txt')
      const f2 = path.join(tmpDir, 'file2.txt')
      await fs.writeFile(f1, 'content 1')
      await fs.writeFile(f2, 'content 2')

      const outcomes = await coordinator.move([f1, f2], destDir)
      expect(outcomes.size).toBe(2)

      const outcome1 = outcomes.get(f1)
      expect(outcome1?.success).toBe(true)
      expect(outcome1?.value).toBe(path.join(destDir, 'file1.txt'))

      const outcome2 = outcomes.get(f2)
      expect(outcome2?.success).toBe(true)
      expect(outcome2?.value).toBe(path.join(destDir, 'file2.txt'))

      // Check moved files exist
      expect(await fs.readFile(path.join(destDir, 'file1.txt'), 'utf-8')).toBe('content 1')
      expect(await fs.readFile(path.join(destDir, 'file2.txt'), 'utf-8')).toBe('content 2')
    })

    it('rejects moving a folder into its own descendant', async () => {
      const parentDir = path.join(tmpDir, 'Parent')
      const subDir = path.join(parentDir, 'Sub')
      const deepDir = path.join(subDir, 'Deep')
      await fs.mkdir(deepDir, { recursive: true })

      const outcomesDeep = await coordinator.move([parentDir], deepDir)
      expect(outcomesDeep.get(parentDir)?.success).toBe(false)
      expect(outcomesDeep.get(parentDir)?.code).toBe('ILLEGAL_RECURSIVE_OPERATION')

      const outcomesSub = await coordinator.move([parentDir], subDir)
      expect(outcomesSub.get(parentDir)?.success).toBe(false)
      expect(outcomesSub.get(parentDir)?.code).toBe('ILLEGAL_RECURSIVE_OPERATION')
    })

    it('rejects moving when destination is not a directory', async () => {
      const fileDest = path.join(tmpDir, 'dest.txt')
      await fs.writeFile(fileDest, 'data')

      const src = path.join(tmpDir, 'source.txt')
      await fs.writeFile(src, 'src data')

      await expect(coordinator.move([src], fileDest)).rejects.toThrow(InvalidInputError)
    })
  })

  describe('copy', () => {
    it('copies files to destination directory and reports conflict on duplicate', async () => {
      const destDir = path.join(tmpDir, 'copy-dest')
      await fs.mkdir(destDir)

      const src = path.join(tmpDir, 'item.txt')
      await fs.writeFile(src, 'copy me')

      // First copy
      const outcomes1 = await coordinator.copy([src], destDir)
      const out1 = outcomes1.get(src)
      expect(out1?.success).toBe(true)
      expect(out1?.value).toBe(path.join(destDir, 'item.txt'))

      // Second copy of same source to same dest -> should report conflict
      const outcomes2 = await coordinator.copy([src], destDir)
      const out2 = outcomes2.get(src)
      expect(out2?.success).toBe(false)
      expect(out2?.code).toBe('CONFLICT')

      // Original file unchanged
      expect(await fs.readFile(path.join(destDir, 'item.txt'), 'utf-8')).toBe('copy me')
    })

    it('recursively copies directories', async () => {
      const srcFolder = path.join(tmpDir, 'SourceFolder')
      await fs.mkdir(path.join(srcFolder, 'Nested'), { recursive: true })
      await fs.writeFile(path.join(srcFolder, 'root.txt'), 'root content')
      await fs.writeFile(path.join(srcFolder, 'Nested', 'nested.txt'), 'nested content')

      const destFolder = path.join(tmpDir, 'TargetFolder')
      await fs.mkdir(destFolder)

      const outcomes = await coordinator.copy([srcFolder], destFolder)
      const out = outcomes.get(srcFolder)
      expect(out?.success).toBe(true)
      expect(out?.value).toBe(path.join(destFolder, 'SourceFolder'))

      expect(await fs.readFile(path.join(destFolder, 'SourceFolder', 'root.txt'), 'utf-8')).toBe('root content')
      expect(await fs.readFile(path.join(destFolder, 'SourceFolder', 'Nested', 'nested.txt'), 'utf-8')).toBe('nested content')
    })

    it('rejects copying a folder into its own descendant', async () => {
      const parentDir = path.join(tmpDir, 'CopyParent')
      const subDir = path.join(parentDir, 'Sub')
      await fs.mkdir(subDir, { recursive: true })

      const outcomes = await coordinator.copy([parentDir], subDir)
      expect(outcomes.get(parentDir)?.success).toBe(false)
      expect(outcomes.get(parentDir)?.code).toBe('ILLEGAL_RECURSIVE_OPERATION')
    })
  })

  describe('delete', () => {
    it('permanently deletes files when permanent flag is true', async () => {
      const f1 = path.join(tmpDir, 'del1.txt')
      const f2 = path.join(tmpDir, 'del2.txt')
      await fs.writeFile(f1, 'delete 1')
      await fs.writeFile(f2, 'delete 2')

      const deleted = await coordinator.delete([f1, f2], true)
      expect(deleted).toContain(f1)
      expect(deleted).toContain(f2)

      await expect(fs.stat(f1)).rejects.toThrow()
      await expect(fs.stat(f2)).rejects.toThrow()
    })

    it('permanently deletes directories recursively', async () => {
      const folder = path.join(tmpDir, 'DelFolder')
      await fs.mkdir(path.join(folder, 'inner'), { recursive: true })
      await fs.writeFile(path.join(folder, 'inner', 'file.txt'), 'data')

      const deleted = await coordinator.delete([folder], true)
      expect(deleted).toContain(folder)
      await expect(fs.stat(folder)).rejects.toThrow()
    })

    it('throws unsupported when attempting recycle bin deletion without backend support', async () => {
      const f = path.join(tmpDir, 'recycle.txt')
      await fs.writeFile(f, 'data')

      await expect(coordinator.delete([f], false)).rejects.toThrow(InvalidInputError)

      // File should NOT be deleted
      expect(await fs.readFile(f, 'utf-8')).toBe('data')
    })

    it('records partial deletion state when an item in the batch fails', async () => {
      const f1 = path.join(tmpDir, 'part1.txt')
      const f2 = path.join(tmpDir, 'nonexistent.txt')
      await fs.writeFile(f1, 'data1')

      try {
        await coordinator.delete([f1, f2], true)
        expect.unreachable('Should have thrown PartialDeletionError')
      } catch (err: unknown) {
        const partialErr = err as import('../src/operations.ts').PartialDeletionError
        expect(partialErr.code).toBe('NOT_FOUND')
        expect(partialErr.deletedPaths).toContain(f1)
        expect(partialErr.deletedPaths).not.toContain(f2)
      }
    })
  })

  describe('concurrency and racing operations', () => {
    it('handles racing renames gracefully and reports NOT_FOUND for disappearing source', async () => {
      const src = path.join(tmpDir, 'race-src.txt')
      await fs.writeFile(src, 'content')

      // First rename succeeds
      await coordinator.rename(src, 'winner.txt')

      // Second rename on original path sees item is gone and reports NOT_FOUND
      await expect(coordinator.rename(src, 'loser.txt')).rejects.toThrow()
      try {
        await coordinator.rename(src, 'loser.txt')
      } catch (err: unknown) {
        expect((err as InvalidInputError).code).toBe('NOT_FOUND')
      }
    })

    it('deduplicates identical paths in delete without failing on second occurrence', async () => {
      const src = path.join(tmpDir, 'dedup-delete.txt')
      await fs.writeFile(src, 'content')

      const deleted = await coordinator.delete([src, src], true)
      expect(deleted).toHaveLength(1)
      expect(deleted[0]).toBe(src)
      await expect(fs.stat(src)).rejects.toThrow()
    })

    it('deduplicates identical paths in move and returns clean outcome', async () => {
      const src = path.join(tmpDir, 'dedup-move.txt')
      const targetDir = path.join(tmpDir, 'sub')
      await fs.mkdir(targetDir)
      await fs.writeFile(src, 'content')

      const outcomes = await coordinator.move([src, src], targetDir)
      expect(outcomes.size).toBe(1)
      const res = outcomes.get(src)
      expect(res?.success).toBe(true)
      expect(res?.value).toBe(path.join(targetDir, 'dedup-move.txt'))
    })

    it('deduplicates identical paths in copy and returns clean outcome', async () => {
      const src = path.join(tmpDir, 'dedup-copy.txt')
      const targetDir = path.join(tmpDir, 'sub-copy')
      await fs.mkdir(targetDir)
      await fs.writeFile(src, 'content')

      const outcomes = await coordinator.copy([src, src], targetDir)
      expect(outcomes.size).toBe(1)
      const res = outcomes.get(src)
      expect(res?.success).toBe(true)
      expect(res?.value).toBe(path.join(targetDir, 'dedup-copy.txt'))
    })
  })
})
