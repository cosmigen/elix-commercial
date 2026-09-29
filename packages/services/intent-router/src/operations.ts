/**
 * Authoritative filesystem mutations coordinator for ELIX Intent Router.
 * Implements deterministic rename, move, copy, permanent delete, and folder creation
 * with transactional semantics, path relationship validation, and structured error reporting.
 *
 * @module @deepseek-ai/dsh-intent-router/operations
 */

import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import * as path from 'node:path'
import {
  InvalidInputError,
  validateFolderRelationship,
  validateItemName,
  validatePathSafety,
} from './validation.ts'

/** Error thrown when a multi-item deletion encounters an error after partially deleting items. */
export class PartialDeletionError extends InvalidInputError {
  /** Absolute filesystem paths successfully deleted before encountering a failure. */
  readonly deletedPaths: readonly string[]

  constructor(message: string, code: string, deletedPaths: readonly string[]) {
    super(message, code)
    this.name = 'PartialDeletionError'
    this.deletedPaths = deletedPaths
  }
}

/**
 * Maps Node filesystem errors to standardized ELIX domain error codes.
 *
 * @param err - Raw error thrown by the filesystem API or runtime.
 * @param defaultCode - Fallback error classification code when no specific mapping matches.
 * @returns An InvalidInputError categorized with an appropriate domain error code.
 */
export function mapFsError(err: unknown, defaultCode = 'NATIVE_FAILURE'): InvalidInputError {
  if (err instanceof InvalidInputError) return err
  const nodeCode = typeof err === 'object' && err !== null && 'code' in err
    ? err.code
    : undefined
  if (nodeCode === 'ENOENT') {
    return new InvalidInputError(err instanceof Error ? err.message : String(err), 'NOT_FOUND')
  }
  if (nodeCode === 'EEXIST') {
    return new InvalidInputError(err instanceof Error ? err.message : String(err), 'CONFLICT')
  }
  if (nodeCode === 'EACCES' || nodeCode === 'EPERM') {
    return new InvalidInputError(err instanceof Error ? err.message : String(err), 'PERMISSION_DENIED')
  }
  if (nodeCode === 'EBUSY') {
    return new InvalidInputError(err instanceof Error ? err.message : String(err), 'CONFLICT')
  }
  return new InvalidInputError(err instanceof Error ? err.message : String(err), defaultCode)
}

/** Structured outcome of an individual file operation. */
export interface OperationOutcome<T = void> {
  readonly success: boolean
  readonly value?: T | undefined
  readonly code?: string | undefined
  readonly error?: string | undefined
}

/**
 * Checks whether a path exists on disk without throwing.
 *
 * @param targetPath - Path to inspect.
 * @returns Stats object if found, or undefined if missing/inaccessible.
 */
export async function safeStat(targetPath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(targetPath)
  } catch {
    return undefined
  }
}

/**
 * Coordinator for filesystem mutations.
 */
export class FileOperationsCoordinator {
  /**
   * Renames a single filesystem object within its existing container.
   *
   * @param sourcePath - Physical absolute path of existing item.
   * @param newName - Proposed new filename or folder name.
   * @returns Updated path on success.
   */
  async rename(sourcePath: string, newName: string): Promise<string> {
    validatePathSafety(sourcePath)
    const validName = validateItemName(newName, 'newName')

    const stat = await safeStat(sourcePath)
    if (!stat) {
      throw new InvalidInputError(`Source item does not exist: "${sourcePath}".`, 'NOT_FOUND')
    }

    const containerDir = path.dirname(sourcePath)
    const destinationPath = path.join(containerDir, validName)

    const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
    const isSamePath = isCaseInsensitive
      ? path.resolve(sourcePath).toLowerCase() === path.resolve(destinationPath).toLowerCase()
      : path.resolve(sourcePath) === path.resolve(destinationPath)

    if (isSamePath) {
      // Case-only rename on Windows or identical name
      if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
        return destinationPath
      }
    } else {
      const destStat = await safeStat(destinationPath)
      if (destStat) {
        throw new InvalidInputError(
          `Destination item already exists: "${validName}".`,
          'CONFLICT',
        )
      }
    }

    try {
      await fs.rename(sourcePath, destinationPath)
    } catch (err: unknown) {
      throw mapFsError(err, 'NATIVE_FAILURE')
    }

    return destinationPath
  }

  /**
   * Moves one or more filesystem objects to a destination directory container.
   *
   * @param sourcePaths - Absolute paths of items to move.
   * @param destinationFolder - Absolute path of destination directory.
   * @returns Map of source path to operation outcome.
   */
  async move(
    sourcePaths: readonly string[],
    destinationFolder: string,
  ): Promise<Map<string, OperationOutcome<string>>> {
    validatePathSafety(destinationFolder)
    const destStat = await safeStat(destinationFolder)
    if (!destStat) {
      throw new InvalidInputError(`Destination container does not exist: "${destinationFolder}".`, 'NOT_FOUND')
    }
    if (!destStat.isDirectory()) {
      throw new InvalidInputError(`Destination must be a directory: "${destinationFolder}".`, 'INVALID_REQUEST')
    }

    const results = new Map<string, OperationOutcome<string>>()

    const isWindows = process.platform === 'win32'
    const seen = new Set<string>()
    const uniquePaths: string[] = []
    for (const src of sourcePaths) {
      const key = isWindows ? path.resolve(src).toLowerCase() : path.resolve(src)
      if (!seen.has(key)) {
        seen.add(key)
        uniquePaths.push(src)
      }
    }

    const isCaseInsensitive = isWindows || process.platform === 'darwin'

    for (const src of uniquePaths) {
      try {
        validatePathSafety(src)
        const srcStat = await safeStat(src)
        if (!srcStat) {
          results.set(src, { success: false, code: 'NOT_FOUND', error: `Source does not exist: "${src}".` })
          continue
        }

        if (srcStat.isDirectory()) {
          validateFolderRelationship(src, destinationFolder)
        }

        const itemName = path.basename(src)
        const targetPath = path.join(destinationFolder, itemName)

        const isSameDir = isCaseInsensitive
          ? path.resolve(path.dirname(src)).toLowerCase() === path.resolve(destinationFolder).toLowerCase()
          : path.resolve(path.dirname(src)) === path.resolve(destinationFolder)

        if (isSameDir) {
          results.set(src, { success: false, code: 'CONFLICT', error: 'Item is already in destination folder.' })
          continue
        }

        const targetStat = await safeStat(targetPath)
        if (targetStat) {
          results.set(src, {
            success: false,
            code: 'CONFLICT',
            error: `An item named "${itemName}" already exists in the destination folder.`,
          })
          continue
        }

        try {
          await fs.rename(src, targetPath)
        } catch (renameErr: unknown) {
          // EXDEV fallback: cross-device copy then unlink
          const isExdev = (renameErr as { code?: string }).code === 'EXDEV'
          if (isExdev) {
            if (srcStat.isDirectory()) {
              await fs.cp(src, targetPath, { recursive: true })
              await fs.rm(src, { recursive: true, force: true })
            } else {
              await fs.copyFile(src, targetPath)
              await fs.unlink(src)
            }
          } else {
            throw renameErr
          }
        }

        results.set(src, { success: true, value: targetPath })
      } catch (err: unknown) {
        const mapped = mapFsError(err, 'NATIVE_FAILURE')
        results.set(src, {
          success: false,
          code: mapped.code,
          error: mapped.message,
        })
      }
    }

    return results
  }

  /**
   * Copies one or more filesystem objects to a destination directory container.
   *
   * @param sourcePaths - Absolute paths of items to copy.
   * @param destinationFolder - Absolute path of destination directory.
   * @returns Map of source path to operation outcome.
   */
  async copy(
    sourcePaths: readonly string[],
    destinationFolder: string,
  ): Promise<Map<string, OperationOutcome<string>>> {
    validatePathSafety(destinationFolder)
    const destStat = await safeStat(destinationFolder)
    if (!destStat) {
      throw new InvalidInputError(`Destination container does not exist: "${destinationFolder}".`, 'NOT_FOUND')
    }
    if (!destStat.isDirectory()) {
      throw new InvalidInputError(`Destination must be a directory: "${destinationFolder}".`, 'INVALID_REQUEST')
    }

    const results = new Map<string, OperationOutcome<string>>()

    const isWindows = process.platform === 'win32'
    const seen = new Set<string>()
    const uniquePaths: string[] = []
    for (const src of sourcePaths) {
      const key = isWindows ? path.resolve(src).toLowerCase() : path.resolve(src)
      if (!seen.has(key)) {
        seen.add(key)
        uniquePaths.push(src)
      }
    }

    for (const src of uniquePaths) {
      try {
        validatePathSafety(src)
        const srcStat = await safeStat(src)
        if (!srcStat) {
          results.set(src, { success: false, code: 'NOT_FOUND', error: `Source does not exist: "${src}".` })
          continue
        }

        if (srcStat.isDirectory()) {
          validateFolderRelationship(src, destinationFolder)
        }

        const itemName = path.basename(src)
        const targetPath = path.join(destinationFolder, itemName)

        const targetStat = await safeStat(targetPath)
        if (targetStat) {
          results.set(src, {
            success: false,
            code: 'CONFLICT',
            error: `An item named "${itemName}" already exists in the destination folder.`,
          })
          continue
        }

        if (srcStat.isDirectory()) {
          await fs.cp(src, targetPath, { recursive: true })
        } else {
          await fs.copyFile(src, targetPath)
        }

        results.set(src, { success: true, value: targetPath })
      } catch (err: unknown) {
        const mapped = mapFsError(err, 'NATIVE_FAILURE')
        results.set(src, {
          success: false,
          code: mapped.code,
          error: mapped.message,
        })
      }
    }

    return results
  }

  /**
   * Deletes items from disk.
   * Enforces explicit permanent deletion policy. Recycle Bin deletion returns unsupported
   * until backed by authoritative Windows shell capabilities.
   *
   * @param sourcePaths - Absolute paths of items to delete.
   * @param permanent - Must be explicitly true for permanent deletion.
   * @returns List of successfully deleted paths.
   */
  async delete(
    sourcePaths: readonly string[],
    permanent = false,
  ): Promise<readonly string[]> {
    if (!permanent) {
      throw new InvalidInputError(
        'Recycle Bin deletion is not supported by the current provider. To delete permanently, specify permanent: true.',
        'UNSUPPORTED',
      )
    }

    const isWindows = process.platform === 'win32'
    const seen = new Set<string>()
    const uniquePaths: string[] = []
    for (const src of sourcePaths) {
      const key = isWindows ? path.resolve(src).toLowerCase() : path.resolve(src)
      if (!seen.has(key)) {
        seen.add(key)
        uniquePaths.push(src)
      }
    }

    const deleted: string[] = []

    for (const src of uniquePaths) {
      validatePathSafety(src)
      const stat = await safeStat(src)
      if (!stat) {
        throw new PartialDeletionError(`Item does not exist: "${src}".`, 'NOT_FOUND', deleted)
      }

      try {
        if (stat.isDirectory()) {
          await fs.rm(src, { recursive: true, force: true })
        } else {
          await fs.unlink(src)
        }
        deleted.push(src)
      } catch (err: unknown) {
        const mapped = mapFsError(err, 'PERMISSION_DENIED')
        throw new PartialDeletionError(
          `Failed to delete item "${src}": ${mapped.message}`,
          mapped.code,
          deleted,
        )
      }
    }

    return deleted
  }

  /**
   * Creates a new directory inside an existing container.
   *
   * @param destinationFolder - Parent container directory.
   * @param name - Name of new folder.
   * @returns Physical path of created folder.
   */
  async createFolder(destinationFolder: string, name: string): Promise<string> {
    validatePathSafety(destinationFolder)
    const validName = validateItemName(name, 'name')

    const parentStat = await safeStat(destinationFolder)
    if (!parentStat) {
      throw new InvalidInputError(`Destination container does not exist: "${destinationFolder}".`, 'NOT_FOUND')
    }
    if (!parentStat.isDirectory()) {
      throw new InvalidInputError(`Destination must be a directory: "${destinationFolder}".`, 'INVALID_REQUEST')
    }

    const targetPath = path.join(destinationFolder, validName)
    const targetStat = await safeStat(targetPath)
    if (targetStat) {
      throw new InvalidInputError(`Folder "${validName}" already exists in destination.`, 'CONFLICT')
    }

    try {
      await fs.mkdir(targetPath)
    } catch (err: unknown) {
      throw mapFsError(err, 'NATIVE_FAILURE')
    }

    return targetPath
  }
}
