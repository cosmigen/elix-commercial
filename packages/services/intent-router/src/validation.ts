/**
 * Strict security and input validation for the ELIX Intent Router.
 * Protects against path traversal, invalid filename characters, DOS device names,
 * recursive folder operations, command injection, and forged identifiers.
 *
 * @module @deepseek-ai/dsh-intent-router/validation
 */

import * as path from 'node:path'
import type { AppId, ShellIntent, ShellItemId } from './types.ts'

/** Custom error thrown when input fails security or semantic validation. */
export class InvalidInputError extends Error {
  /** Error classification code identifying the specific validation failure. */
  readonly code: string

  constructor(message: string, code = 'INVALID_REQUEST') {
    super(message)
    this.name = 'InvalidInputError'
    this.code = code
  }
}

/** Reserved DOS device names forbidden in Windows file/folder naming. */
const RESERVED_DOS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** Illegal characters forbidden in Windows filenames: < > : " / \ | ? * and ASCII 0-31. */
const ILLEGAL_NAME_CHARS_REGEX = /[<>:"/\\|?*\x00-\x1F]/

/**
 * Validates a raw item identifier as a safe, well-formed ShellItemId.
 *
 * @param id - Untrusted ID string.
 * @returns Strongly typed ShellItemId.
 */
export function validateShellItemId(id: unknown): ShellItemId {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new InvalidInputError('Shell item identifier must be a non-empty string.', 'INVALID_ITEM_ID')
  }
  if (id.length > 512) {
    throw new InvalidInputError('Shell item identifier exceeds maximum permitted length of 512 characters.', 'INVALID_ITEM_ID')
  }
  if (/[\x00-\x1F]/.test(id) || id.includes('..')) {
    throw new InvalidInputError('Shell item identifier contains illegal control characters or path traversal sequences.', 'INVALID_ITEM_ID')
  }
  if (/^[a-zA-Z]:[\\/]/.test(id) || /[\\/]/.test(id)) {
    throw new InvalidInputError('Shell item identifier cannot be a raw filesystem path.', 'INVALID_ITEM_ID')
  }
  if (/[&|;><`$]/.test(id)) {
    throw new InvalidInputError('Shell item identifier contains forbidden shell command characters.', 'INVALID_ITEM_ID')
  }
  return id as ShellItemId
}

/**
 * Validates a raw application identifier as a safe, well-formed AppId.
 *
 * @param id - Untrusted application ID string.
 * @returns Strongly typed AppId.
 */
export function validateAppId(id: unknown): AppId {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new InvalidInputError('Application identifier must be a non-empty string.', 'INVALID_APP_ID')
  }
  if (id.length > 256) {
    throw new InvalidInputError('Application identifier exceeds maximum permitted length of 256 characters.', 'INVALID_APP_ID')
  }
  if (/[\x00-\x1F]/.test(id) || id.includes('..')) {
    throw new InvalidInputError('Application identifier contains illegal control characters or path traversal sequences.', 'INVALID_APP_ID')
  }
  if (/^[a-zA-Z]:[\\/]/.test(id) || /[\\/]/.test(id) || /\.(exe|bat|cmd|ps1|vbs|msi|com)$/i.test(id)) {
    throw new InvalidInputError('Application identifier cannot be an arbitrary executable path.', 'INVALID_APP_ID')
  }
  if (/[&|;><`$]/.test(id)) {
    throw new InvalidInputError('Application identifier contains forbidden shell command characters.', 'INVALID_APP_ID')
  }
  return id as AppId
}

/**
 * Validates a proposed file or folder name for Windows filesystem compliance and security.
 *
 * @param name - Untrusted name string.
 * @param field - Field name for error reporting.
 * @returns Validated, trimmed name string.
 */
export function validateItemName(name: unknown, field = 'name'): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new InvalidInputError(`${field} must be a non-empty string.`, 'INVALID_NAME')
  }

  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new InvalidInputError(`${field} cannot end with a period or space in Windows.`, 'INVALID_NAME')
  }

  const trimmed = name.trim()

  if (trimmed.length > 255) {
    throw new InvalidInputError(`${field} exceeds maximum permitted length of 255 characters.`, 'INVALID_NAME')
  }

  if (trimmed === '.' || trimmed === '..') {
    throw new InvalidInputError(`${field} cannot be '.' or '..'.`, 'PATH_TRAVERSAL')
  }

  if (ILLEGAL_NAME_CHARS_REGEX.test(trimmed)) {
    throw new InvalidInputError(
      `${field} contains forbidden Windows filename characters (< > : " / \\ | ? * or control characters).`,
      'INVALID_NAME_CHARACTERS',
    )
  }

  // Check for reserved DOS device names (e.g. "CON", "NUL", "AUX.txt", "com1.log")
  const dotIndex = trimmed.indexOf('.')
  const stem = (dotIndex >= 0 ? trimmed.slice(0, dotIndex) : trimmed).toLowerCase()
  if (RESERVED_DOS_NAMES.has(stem)) {
    throw new InvalidInputError(
      `${field} '${trimmed}' is a reserved Windows device name (e.g. CON, PRN, AUX, NUL).`,
      'RESERVED_DEVICE_NAME',
    )
  }

  return trimmed
}

/**
 * Validates that a destination container is not identical to or a descendant of the source.
 * Prevents recursive folder copy/move loops that corrupt directory hierarchies.
 *
 * @param sourcePath - Physical source path.
 * @param destinationPath - Physical destination container path.
 */
export function validateFolderRelationship(sourcePath: string, destinationPath: string): void {
  const normSrc = path.resolve(sourcePath).replace(/\\/g, '/').toLowerCase()
  const normDest = path.resolve(destinationPath).replace(/\\/g, '/').toLowerCase()

  if (normSrc === normDest) {
    throw new InvalidInputError('Cannot move or copy a folder into itself.', 'ILLEGAL_RECURSIVE_OPERATION')
  }

  if (normDest.startsWith(normSrc + '/')) {
    throw new InvalidInputError(
      'Cannot move or copy a folder into one of its own subdirectories or descendants.',
      'ILLEGAL_RECURSIVE_OPERATION',
    )
  }
}

/**
 * Validates path safety: must be absolute, free of traversal or control sequences, and cannot target root filesystem drives.
 *
 * @param targetPath - Absolute path to inspect.
 * @returns Validated targetPath string.
 */
export function validatePathSafety(targetPath: string): string {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new InvalidInputError('Path must be a non-empty string.', 'PATH_NOT_ABSOLUTE')
  }

  if (/[\x00-\x1F]/.test(targetPath)) {
    throw new InvalidInputError('Path contains forbidden control characters or null bytes.', 'INVALID_PATH')
  }

  if (targetPath.includes('..')) {
    throw new InvalidInputError(`Path traversal sequences ('..') are forbidden: "${targetPath}".`, 'PATH_TRAVERSAL')
  }

  if (!path.isAbsolute(targetPath)) {
    throw new InvalidInputError(`Path must be absolute: "${targetPath}".`, 'PATH_NOT_ABSOLUTE')
  }

  const norm = path.resolve(targetPath).replace(/\\/g, '/')
  // Prevent operations on root drive mounts directly (e.g. "C:/" or "/")
  if (/^[a-zA-Z]:\/?$/.test(norm) || norm === '/') {
    throw new InvalidInputError(`Operations on root drive mount are forbidden: "${targetPath}".`, 'ROOT_DRIVE_OPERATION_FORBIDDEN')
  }

  return targetPath
}

/**
 * Validates an untrusted intent payload from external or renderer input.
 *
 * @param value - Untrusted JSON-like payload.
 * @returns Strictly validated ShellIntent.
 */
export function validateIntent(value: unknown): ShellIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidInputError('Intent payload must be a non-null object.', 'MALFORMED_INTENT')
  }

  const record = value as Record<string, unknown>
  const type = record.type

  if (typeof type !== 'string' || type.trim().length === 0) {
    throw new InvalidInputError('Intent payload missing required string property "type".', 'MALFORMED_INTENT')
  }

  switch (type) {
    case 'open-app': {
      return {
        type,
        appId: validateAppId(record.appId),
        options: record.options && typeof record.options === 'object'
          ? record.options
          : undefined,
      }
    }
    case 'open-file':
    case 'open-folder':
    case 'open-shortcut':
    case 'reveal-in-folder':
    case 'resolve-target':
    case 'get-available-actions': {
      return {
        type,
        itemId: validateShellItemId(record.itemId),
      }
    }
    case 'rename': {
      return {
        type,
        itemId: validateShellItemId(record.itemId),
        newName: validateItemName(record.newName, 'newName'),
      }
    }
    case 'delete': {
      if (!Array.isArray(record.itemIds) || record.itemIds.length === 0) {
        throw new InvalidInputError('Delete intent requires a non-empty array of itemIds.', 'INVALID_REQUEST')
      }
      return {
        type,
        itemIds: record.itemIds.map(id => validateShellItemId(id)),
        permanent: typeof record.permanent === 'boolean' ? record.permanent : undefined,
      }
    }
    case 'move':
    case 'copy': {
      if (!Array.isArray(record.itemIds) || record.itemIds.length === 0) {
        throw new InvalidInputError(`${type} intent requires a non-empty array of itemIds.`, 'INVALID_REQUEST')
      }
      return {
        type,
        itemIds: record.itemIds.map(id => validateShellItemId(id)),
        destinationId: validateShellItemId(record.destinationId),
      }
    }
    case 'create-folder': {
      return {
        type,
        destinationId: validateShellItemId(record.destinationId),
        name: validateItemName(record.name, 'name'),
      }
    }
    default:
      throw new InvalidInputError(`Unsupported or unrecognized intent type '${type}'.`, 'UNSUPPORTED_INTENT')
  }
}
