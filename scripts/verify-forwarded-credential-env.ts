/**
 * Doc-sync gate for `FORWARDED_CREDENTIAL_ENV`, the closed set of
 * credential-shaped environment names `scrubbedParentEnv` forwards into every
 * spawned child. Each exempted name widens what a model-driven subprocess can
 * reach, so the set is only allowed to change together with its documented
 * per-variable record: this gate parses the set and `SENSITIVE_ENV_PATTERN`
 * from the seam source, parses the marked table from both language sides of
 * the subprocess subsystem page, and rejects any disagreement, any row missing
 * its use case, risk, or review reference, and any entry the scrub could never
 * consult.
 * See the [change-control Agent Note](../.agents/notes/implemented/process/2026-08-28-forwarded-credential-env-change-control.md).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/** The seam source that owns the exemption set and the scrub pattern. */
export const SEAM_SOURCE = 'packages/subprocess/subprocess/src/index.ts'

/** Both language sides of the page that owns the per-variable security record. */
export const RECORD_DOCS = ['docs/subsystems/subprocess.md', 'docs/subsystems/subprocess.zh.md']

/** The rendered-away marker that pins the record table in every language. */
export const TABLE_MARKER = '<!-- forwarded-credential-env -->'

/** Data columns each record row carries after the variable name. */
const ROW_FIELDS = ['use case', 'risk', 'review reference'] as const

/** One parsed record row: the variable plus its three prose columns. */
export interface DocumentedCredential {
  name: string
  /** 1-based source line of the row, for diagnostics. */
  line: number
  fields: string[]
}

/** The seam facts this gate grades documentation against. */
export interface SeamCredentialPolicy {
  forwarded: string[]
  sensitivePattern: RegExp
}

/**
 * Read `FORWARDED_CREDENTIAL_ENV` and `SENSITIVE_ENV_PATTERN` out of the seam
 * source rather than importing them, so the gate stays in the source plane and
 * needs no workspace resolution.
 * @param source - TypeScript source text of {@link SEAM_SOURCE}.
 * @param path - repository-relative path used in thrown diagnostics.
 * @returns the forwarded names in declaration order and the scrub pattern.
 */
export function parseSeamCredentialPolicy(source: string, path = SEAM_SOURCE): SeamCredentialPolicy {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const forwarded = declarationInitializer(file, 'FORWARDED_CREDENTIAL_ENV', path)
  if (
    !ts.isNewExpression(forwarded)
    || !ts.isIdentifier(forwarded.expression)
    || forwarded.expression.text !== 'Set'
    || forwarded.arguments?.length !== 1
  ) {
    throw new Error(`${path}: FORWARDED_CREDENTIAL_ENV must stay \`new Set([...])\` over string literals for this gate to read it`)
  }
  const [entries] = forwarded.arguments
  if (entries === undefined || !ts.isArrayLiteralExpression(entries)) {
    throw new Error(`${path}: FORWARDED_CREDENTIAL_ENV must be constructed from an array literal`)
  }
  const names = entries.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error(`${path}: every FORWARDED_CREDENTIAL_ENV entry must be a plain string literal`)
    }
    return element.text
  })

  const pattern = declarationInitializer(file, 'SENSITIVE_ENV_PATTERN', path)
  if (!ts.isRegularExpressionLiteral(pattern)) {
    throw new Error(`${path}: SENSITIVE_ENV_PATTERN must stay a regular-expression literal for this gate to read it`)
  }
  const body = pattern.text.slice(1, pattern.text.lastIndexOf('/'))
  const flags = pattern.text.slice(pattern.text.lastIndexOf('/') + 1)
  return { forwarded: names, sensitivePattern: new RegExp(body, flags) }
}

function declarationInitializer(file: ts.SourceFile, name: string, path: string): ts.Expression {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      if (declaration.initializer === undefined) break
      return declaration.initializer
    }
  }
  throw new Error(`${path}: no \`${name}\` declaration with an initializer (renamed or moved? update scripts/verify-forwarded-credential-env.ts in the same change)`)
}

/**
 * Parse the marked record table out of one language side. The table is read
 * from raw lines so both language sides parse identically regardless of their
 * translated column headings.
 * @param markdown - Markdown source of one record document.
 * @param path - repository-relative path used in thrown diagnostics.
 * @returns each documented variable with its prose columns, in table order.
 */
export function parseDocumentedCredentials(markdown: string, path: string): DocumentedCredential[] {
  const lines = markdown.split('\n')
  const markerIndex = lines.findIndex(line => line.trim() === TABLE_MARKER)
  if (markerIndex === -1) {
    throw new Error(`${path}: no \`${TABLE_MARKER}\` marker — the forwarded-credential record table must stay pinned by that comment`)
  }
  const table: { line: number; cells: string[] }[] = []
  for (let index = markerIndex + 1; index < lines.length; index++) {
    const raw = lines[index] ?? ''
    if (table.length === 0 && raw.trim() === '') continue
    if (!raw.trimStart().startsWith('|')) break
    table.push({ line: index + 1, cells: tableCells(raw) })
  }
  if (table.length < 3) {
    throw new Error(`${path}:${markerIndex + 1}: the \`${TABLE_MARKER}\` marker must be followed by a table with a header, a delimiter, and at least one row`)
  }
  return table.slice(2).map(({ line, cells }) => {
    const [first, ...fields] = cells
    const name = /^`([^`]+)`$/.exec(first ?? '')?.[1]
    if (name === undefined) {
      throw new Error(`${path}:${line}: the first cell of a record row must be the variable name in backticks, got ${JSON.stringify(first ?? '')}`)
    }
    return { name, line, fields }
  })
}

function tableCells(row: string): string[] {
  const trimmed = row.trim()
  const inner = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined)
  return inner.split('|').map(cell => cell.trim())
}

/**
 * Grade one language side of the record against the seam source.
 * @param policy - the parsed seam facts.
 * @param documented - the parsed record rows for one document.
 * @param path - repository-relative path used in the returned diagnostics.
 * @returns one message per disagreement; empty when the record is exact.
 */
export function recordFailures(
  policy: SeamCredentialPolicy,
  documented: readonly DocumentedCredential[],
  path: string,
): string[] {
  const failures: string[] = []
  const documentedNames = documented.map(row => row.name)

  for (const name of policy.forwarded) {
    if (documentedNames.includes(name)) continue
    failures.push(`${path}: \`${name}\` is forwarded by ${SEAM_SOURCE} but has no row — an exemption lands with its use case, risk, and review reference in the same change`)
  }
  for (const row of documented) {
    if (policy.forwarded.includes(row.name)) continue
    failures.push(`${path}:${row.line}: \`${row.name}\` is documented as forwarded but is absent from FORWARDED_CREDENTIAL_ENV — drop the row or restore the entry`)
  }
  if (
    documentedNames.length === policy.forwarded.length
    && documentedNames.some((name, index) => name !== policy.forwarded[index])
    && documentedNames.every(name => policy.forwarded.includes(name))
  ) {
    failures.push(`${path}: rows are ordered ${documentedNames.join(', ')} but ${SEAM_SOURCE} declares ${policy.forwarded.join(', ')} — keep both orders identical so a review diff lines up`)
  }
  for (const row of documented) {
    if (row.fields.length !== ROW_FIELDS.length) {
      failures.push(`${path}:${row.line}: \`${row.name}\` has ${row.fields.length} prose column(s); each row carries its ${ROW_FIELDS.join(', ')}`)
      continue
    }
    for (const [index, field] of ROW_FIELDS.entries()) {
      if ((row.fields[index] ?? '').length === 0) {
        failures.push(`${path}:${row.line}: \`${row.name}\` has an empty ${field} cell — an exemption without one is not reviewable`)
      }
    }
  }
  return failures
}

/**
 * Reject entries the scrub can never consult, which is what a typo produces.
 * @param policy - the parsed seam facts.
 * @returns one message per dead entry; empty when every entry is live.
 */
export function deadEntryFailures(policy: SeamCredentialPolicy): string[] {
  const failures: string[] = []
  for (const name of policy.forwarded) {
    if (name !== name.toUpperCase()) {
      failures.push(`${SEAM_SOURCE}: \`${name}\` is not upper-case, so the set is never consulted for it — scrubbedParentEnv looks the entry up by the upper-cased ambient name`)
    }
    if (!policy.sensitivePattern.test(name)) {
      failures.push(`${SEAM_SOURCE}: \`${name}\` does not match SENSITIVE_ENV_PATTERN, so it is forwarded already and the exemption is dead — a misspelled credential name is the usual cause`)
    }
  }
  return failures
}

if (import.meta.main) {
  const failures: string[] = []
  const policy = parseSeamCredentialPolicy(readFileSync(resolve(root, SEAM_SOURCE), 'utf8'))
  failures.push(...deadEntryFailures(policy))
  for (const path of RECORD_DOCS) {
    failures.push(...recordFailures(policy, parseDocumentedCredentials(readFileSync(resolve(root, path), 'utf8'), path), path))
  }

  if (failures.length > 0) {
    console.error(`verify-forwarded-credential-env: ${failures.length} problem(s).\n`)
    for (const failure of failures) console.error(`  ${failure}`)
    console.error('\nThe forwarded-credential exemption set is a security boundary: changing it requires the matching record row on both language sides of docs/subsystems/subprocess.md.')
    process.exitCode = 1
  } else {
    console.log(`verify-forwarded-credential-env: ${policy.forwarded.length} forwarded name(s) recorded on ${RECORD_DOCS.length} language side(s).`)
  }
}
