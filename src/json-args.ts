/**
 * Best-effort JSON argument parsing for tool cards and plan payloads.
 */

export function parseJsonArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

/** A short scalar rendering of one argument value, or null for objects/arrays. */
export function scalarText(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}
