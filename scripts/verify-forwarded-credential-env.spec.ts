/**
 * The forwarded-credential change-control gate: the exemption set and its
 * per-variable record must agree exactly, every row must carry its use case,
 * risk, and review reference, and an entry the scrub could never consult is
 * rejected as the typo it usually is.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deadEntryFailures,
  parseDocumentedCredentials,
  parseSeamCredentialPolicy,
  recordFailures,
  RECORD_DOCS,
  SEAM_SOURCE,
  TABLE_MARKER,
} from './verify-forwarded-credential-env.ts'

const root = resolve(import.meta.dirname, '..')

const seam = `
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
export const FORWARDED_CREDENTIAL_ENV = new Set([
  'GITHUB_TOKEN',
  'NPM_TOKEN',
])
`

function record(rows: string): string {
  return `## Heading\n\n${TABLE_MARKER}\n\n| Variable | Forwarded so that | Reach granted | Reviewed |\n| --- | --- | --- | --- |\n${rows}`
}

const completeRows = [
  '| `GITHUB_TOKEN` | `gh` authenticates | full API reach | seam review |',
  '| `NPM_TOKEN` | `npm` installs | registry publish reach | seam review |',
].join('\n')

describe('parseSeamCredentialPolicy', () => {
  it('reads the declared order and the scrub pattern from source', () => {
    expect(parseSeamCredentialPolicy(seam)).toEqual({
      forwarded: ['GITHUB_TOKEN', 'NPM_TOKEN'],
      sensitivePattern: /KEY|PASSWORD|SECRET|TOKEN/i,
    })
  })

  it('rejects a set the gate can no longer read', () => {
    expect(() => parseSeamCredentialPolicy('export const FORWARDED_CREDENTIAL_ENV = names\n'))
      .toThrow(/must stay `new Set\(\[\.\.\.\]\)`/)
  })

  it('rejects a renamed declaration instead of reporting an empty set', () => {
    expect(() => parseSeamCredentialPolicy('export const SENSITIVE_ENV_PATTERN = /TOKEN/i\n'))
      .toThrow(/no `FORWARDED_CREDENTIAL_ENV` declaration/)
  })
})

describe('parseDocumentedCredentials', () => {
  it('rejects a document whose record table lost its marker', () => {
    expect(() => parseDocumentedCredentials('# Page\n\n| a | b |\n', 'doc.md'))
      .toThrow(/no `<!-- forwarded-credential-env -->` marker/)
  })

  it('rejects a marker with no table under it', () => {
    expect(() => parseDocumentedCredentials(`${TABLE_MARKER}\n\nprose\n`, 'doc.md'))
      .toThrow(/must be followed by a table/)
  })

  it('rejects a row whose first cell is not a variable name', () => {
    expect(() => parseDocumentedCredentials(record('| GITHUB_TOKEN | a | b | c |'), 'doc.md'))
      .toThrow(/must be the variable name in backticks/)
  })
})

describe('recordFailures', () => {
  const policy = parseSeamCredentialPolicy(seam)

  it('accepts a record that matches the set exactly', () => {
    expect(recordFailures(policy, parseDocumentedCredentials(record(completeRows), 'doc.md'), 'doc.md')).toEqual([])
  })

  it('rejects a forwarded name that was never documented', () => {
    const rows = '| `GITHUB_TOKEN` | `gh` authenticates | full API reach | seam review |'
    const failures = recordFailures(policy, parseDocumentedCredentials(record(rows), 'doc.md'), 'doc.md')
    expect(failures).toEqual([expect.stringContaining('`NPM_TOKEN` is forwarded by')])
  })

  it('rejects a documented name the set no longer forwards', () => {
    const rows = `${completeRows}\n| \`AWS_SESSION_TOKEN\` | stale | stale | stale |`
    const failures = recordFailures(policy, parseDocumentedCredentials(record(rows), 'doc.md'), 'doc.md')
    expect(failures).toEqual([expect.stringContaining('`AWS_SESSION_TOKEN` is documented as forwarded but is absent')])
  })

  it('rejects a record that reorders the set', () => {
    const rows = completeRows.split('\n').reverse().join('\n')
    const failures = recordFailures(policy, parseDocumentedCredentials(record(rows), 'doc.md'), 'doc.md')
    expect(failures).toEqual([expect.stringContaining('keep both orders identical')])
  })

  it('rejects a row with an empty risk cell', () => {
    const rows = completeRows.replace('full API reach', '')
    const failures = recordFailures(policy, parseDocumentedCredentials(record(rows), 'doc.md'), 'doc.md')
    expect(failures).toEqual([expect.stringContaining('empty risk cell')])
  })

  it('rejects a row that dropped its review reference column', () => {
    const rows = '| `GITHUB_TOKEN` | `gh` authenticates | full API reach |\n| `NPM_TOKEN` | `npm` installs | registry publish reach |'
    const failures = recordFailures(policy, parseDocumentedCredentials(record(rows), 'doc.md'), 'doc.md')
    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('has 2 prose column(s)')
  })
})

describe('deadEntryFailures', () => {
  it('accepts entries the scrub actually consults', () => {
    expect(deadEntryFailures(parseSeamCredentialPolicy(seam))).toEqual([])
  })

  it('rejects a misspelled credential name the pattern never matches', () => {
    const typo = seam.replace("'NPM_TOKEN'", "'NPM_TOKN'")
    expect(deadEntryFailures(parseSeamCredentialPolicy(typo)))
      .toEqual([expect.stringContaining('does not match SENSITIVE_ENV_PATTERN')])
  })

  it('rejects a lower-case entry the upper-cased lookup can never hit', () => {
    const lowered = seam.replace("'NPM_TOKEN'", "'npm_token'")
    expect(deadEntryFailures(parseSeamCredentialPolicy(lowered)))
      .toEqual([expect.stringContaining('is not upper-case')])
  })
})

describe('the repository record', () => {
  const policy = parseSeamCredentialPolicy(readFileSync(resolve(root, SEAM_SOURCE), 'utf8'))

  it('forwards only entries the scrub consults', () => {
    expect(deadEntryFailures(policy)).toEqual([])
  })

  it.each(RECORD_DOCS)('documents every forwarded name in %s', (path) => {
    const documented = parseDocumentedCredentials(readFileSync(resolve(root, path), 'utf8'), path)
    expect(recordFailures(policy, documented, path)).toEqual([])
  })
})
