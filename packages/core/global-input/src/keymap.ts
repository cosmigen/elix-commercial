import { GlobalInputError, type GlobalHotkeyBinding, type NormalizedGlobalHotkeyBinding } from './types.ts'

const NAMED_KEYS: Readonly<Record<string, number>> = Object.freeze({
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  END: 0x23,
  HOME: 0x24,
  ARROWLEFT: 0x25,
  ARROWUP: 0x26,
  ARROWRIGHT: 0x27,
  ARROWDOWN: 0x28,
  INSERT: 0x2d,
  DELETE: 0x2e,
})

function canonicalKey(key: string): string {
  const trimmed = key.trim()
  if (!trimmed) throw new GlobalInputError('INVALID_BINDING', 'Global hotkey key cannot be empty.')

  if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase()
  if (/^[0-9]$/.test(trimmed)) return trimmed

  const upper = trimmed.toUpperCase().replace(/[ _-]/g, '')
  const named = Object.keys(NAMED_KEYS).find(candidate => candidate === upper)
  if (named) {
    const pretty: Record<string, string> = {
      BACKSPACE: 'Backspace', TAB: 'Tab', ENTER: 'Enter', ESCAPE: 'Escape', SPACE: 'Space',
      PAGEUP: 'PageUp', PAGEDOWN: 'PageDown', END: 'End', HOME: 'Home',
      ARROWLEFT: 'ArrowLeft', ARROWUP: 'ArrowUp', ARROWRIGHT: 'ArrowRight', ARROWDOWN: 'ArrowDown',
      INSERT: 'Insert', DELETE: 'Delete',
    }
    return pretty[named]!
  }

  const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(upper)
  if (functionMatch) return `F${functionMatch[1]}`

  throw new GlobalInputError(
    'INVALID_BINDING',
    `Unsupported global hotkey key '${key}'. Use A-Z, 0-9, F1-F24, navigation keys, Tab, Enter, Escape, or Space.`,
  )
}

export function virtualKeyForKey(key: string): number {
  const canonical = canonicalKey(key)
  if (/^[A-Z]$/.test(canonical)) return canonical.charCodeAt(0)
  if (/^[0-9]$/.test(canonical)) return canonical.charCodeAt(0)
  const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(canonical)
  if (functionMatch) return 0x70 + Number(functionMatch[1]) - 1
  const named = NAMED_KEYS[canonical.toUpperCase()]
  if (named !== undefined) return named
  throw new GlobalInputError('INVALID_BINDING', `Unsupported global hotkey key '${key}'.`)
}

export function normalizeGlobalHotkeyBinding(binding: GlobalHotkeyBinding): NormalizedGlobalHotkeyBinding {
  const id = binding.id.trim()
  if (!id || id.length > 128) {
    throw new GlobalInputError('INVALID_BINDING', 'Global hotkey binding id must contain 1-128 characters.')
  }

  const key = canonicalKey(binding.key)
  const modifiers = Object.freeze({
    alt: binding.modifiers.alt === true,
    control: binding.modifiers.control === true,
    shift: binding.modifiers.shift === true,
    win: binding.modifiers.win === true,
  })

  if (!modifiers.alt && !modifiers.control && !modifiers.shift && !modifiers.win) {
    throw new GlobalInputError(
      'INVALID_BINDING',
      `Global hotkey '${id}' must include at least one modifier; bare global keys are intentionally rejected.`,
    )
  }

  return Object.freeze({
    id,
    key,
    virtualKey: virtualKeyForKey(key),
    modifiers,
    noRepeat: binding.noRepeat !== false,
  })
}

export function sameGlobalHotkeyBinding(
  left: NormalizedGlobalHotkeyBinding,
  right: NormalizedGlobalHotkeyBinding,
): boolean {
  return left.id === right.id
    && left.virtualKey === right.virtualKey
    && left.modifiers.alt === right.modifiers.alt
    && left.modifiers.control === right.modifiers.control
    && left.modifiers.shift === right.modifiers.shift
    && left.modifiers.win === right.modifiers.win
    && left.noRepeat === right.noRepeat
}
