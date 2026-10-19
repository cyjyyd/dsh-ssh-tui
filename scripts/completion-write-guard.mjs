/**
 * Source guard for the Composer draft funnel.
 *
 * W-4B.1 moves every write to the composer draft through `setDraft()` (which
 * materializes completion). A string/regex search would miss `this['input']`,
 * compound assignments, or formatting changes, so this walks the TypeScript AST
 * and records every assignment whose left side is `this.input`.
 *
 * Usage: node scripts/completion-write-guard.mjs [file]
 * Exit 0 when the only write is inside `setDraft`; exit 1 otherwise.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

/** Names of assignment operators TypeScript can place in a BinaryExpression. */
function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function isThisProperty(node, name) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === name
  }
  if (ts.isElementAccessExpression(node)) {
    return node.expression.kind === ts.SyntaxKind.ThisKeyword
      && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === name
  }
  return false
}

function enclosingFunctionName(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isMethodDeclaration(current)
      || ts.isFunctionDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
      || ts.isConstructorDeclaration(current)) {
      if (current.name !== undefined && ts.isIdentifier(current.name)) return current.name.text
      return '<anonymous>'
    }
    current = current.parent
  }
  return '<top-level>'
}

/**
 * @param {string} [file] - source file to inspect, default `src/tui.ts`.
 * @returns {{ line: number, function: string, property: string }[]} violations.
 */
export function checkCompletionWrites(file = 'src/tui.ts') {
  const path = resolve(file)
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const violations = []
  const guarded = new Set(['input', 'commandSuggestions', 'suggestionIndex'])
  const visit = node => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      for (const property of guarded) {
        if (!isThisProperty(node.left, property)) continue
        const fn = enclosingFunctionName(node)
        if (property === 'input' && fn === 'setDraft') continue
        violations.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          function: fn,
          property,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkCompletionWrites(process.argv[2])
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`completion-write-guard: this.${violation.property} = at src/tui.ts:${violation.line} (in ${violation.function})`)
    }
    process.exit(1)
  }
  console.log('completion-write-guard: every composer draft write goes through setDraft()')
}
