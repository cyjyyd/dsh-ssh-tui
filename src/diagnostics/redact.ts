/**
 * Fail-closed secret scanning and strict field validation.
 *
 * The remote bundle is built from typed, enumerated fields rather than by
 * copying local diagnostics. This module is the second line of defence: it
 * scans every byte that could carry free text before it is packed, and rejects
 * unknown fields instead of silently dropping them.
 */
import { userInfo } from 'node:os'
import { DiagnosticsError, PROBLEM_CLASSES, type ProblemClass } from './types.js'

export interface ScanOptions {
  username?: string
  /** Extra literal values that must never appear (already hashed by caller). */
  forbiddenLiterals?: readonly string[]
}

interface Rule {
  id: string
  test: RegExp
}

const RULES: readonly Rule[] = [
  { id: 'PRIVATE_KEY', test: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { id: 'OPENSSH_PRIVATE_KEY', test: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { id: 'BEARER_TOKEN', test: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { id: 'AUTHORIZATION_HEADER', test: /\bAuthorization\s*:\s*\S+/i },
  { id: 'COOKIE_HEADER', test: /\b(?:Set-)?Cookie\s*:\s*\S+/i },
  { id: 'GITHUB_TOKEN', test: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'GITHUB_PAT', test: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'AWS_ACCESS_KEY', test: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'SLACK_TOKEN', test: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'JWT', test: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: 'MODEL_API_KEY', test: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'URL_CREDENTIALS', test: /https?:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { id: 'PASSWORD_ASSIGNMENT', test: /\b(?:password|passwd|pwd)\s*[:=]\s*\S{3,}/i },
  { id: 'TOKEN_ASSIGNMENT', test: /\b(?:token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i },
  { id: 'ENV_ASSIGNMENT', test: /(?:^|\n)\s*[A-Z][A-Z0-9_]{2,}\s*=\s*\S{4,}/ },
  { id: 'HOME_PATH', test: /(?:^|[^A-Za-z0-9._-])\/(?:home|Users)\/[A-Za-z0-9._-]+/ },
  { id: 'ROOT_PATH', test: /(?:^|[^A-Za-z0-9._-])\/root(?:\/|\b)/ },
  { id: 'WINDOWS_USER_PATH', test: /[A-Za-z]:\\Users\\[^\\\s]+/i },
  { id: 'TILDE_HOME', test: /(?:^|[^A-Za-z0-9._-])~\/[A-Za-z0-9._-]/ },
  { id: 'EMAIL', test: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { id: 'SESSION_UUID', test: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
  { id: 'CONTROL_CHARS', test: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/ },
]

export interface ScanResult {
  ok: boolean
  /** Rule ids only. Never the matched text. */
  findings: string[]
}

export function scanForSecrets(text: string, options: ScanOptions = {}): ScanResult {
  const findings = new Set<string>()
  for (const rule of RULES) {
    if (rule.test.test(text)) findings.add(rule.id)
  }
  const username = options.username ?? userInfo().username
  if (typeof username === 'string' && username.length >= 3) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const userPattern = new RegExp(`(?:^|[^A-Za-z0-9._-])${escaped}(?:[^A-Za-z0-9._-]|$)`, 'i')
    if (userPattern.test(text)) findings.add('USERNAME')
  }
  for (const literal of options.forbiddenLiterals ?? []) {
    if (literal.length >= 4 && text.includes(literal)) findings.add('FORBIDDEN_LITERAL')
  }
  return { ok: findings.size === 0, findings: [...findings].sort() }
}

export function assertNoSecrets(text: string, options: ScanOptions = {}): void {
  const result = scanForSecrets(text, options)
  if (!result.ok) throw new DiagnosticsError('REDACTION_BLOCKED')
}

export function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      void label
      throw new DiagnosticsError('REDACTION_BLOCKED')
    }
  }
}

export function assertRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    void label
    throw new DiagnosticsError('REDACTION_BLOCKED')
  }
  const record = value as Record<string, unknown>
  assertExactKeys(record, allowed, label)
  return record
}

export function boundedString(value: unknown, pattern: RegExp, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || !pattern.test(value)) {
    throw new DiagnosticsError('REDACTION_BLOCKED')
  }
  return value
}

export function boundedInt(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DiagnosticsError('REDACTION_BLOCKED')
  }
  return value
}

export function boundedBool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DiagnosticsError('REDACTION_BLOCKED')
  return value
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DiagnosticsError('REDACTION_BLOCKED')
  }
  return value as T
}

export function problemClasses(value: unknown): ProblemClass[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PROBLEM_CLASSES.length) throw new DiagnosticsError('REDACTION_BLOCKED')
  const out: ProblemClass[] = []
  for (const item of value) out.push(enumValue(item, PROBLEM_CLASSES))
  return [...new Set(out)].sort()
}

export function boundedText(value: string, max: number): string {
  // We never truncate before scanning. Callers pass only bounded, validated
  // fields; this is a final size guard, not a redaction operation.
  if (Buffer.byteLength(value, 'utf8') > max) throw new DiagnosticsError('REDACTION_BLOCKED')
  return value
}

export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+~-]{0,63}$/
export const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/
export const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/
export const BUNDLE_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/
export const HASH_PATTERN = /^[0-9a-f]{64}$/
export const PLATFORM_PATTERN = /^(?:linux|darwin|win32|freebsd|openbsd|sunos|aix|android)$/
export const ARCH_PATTERN = /^(?:x64|arm64|arm|ia32|ppc64|s390x|mips|riscv64)$/
