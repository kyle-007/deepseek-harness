# Agent Note: Change control for the forwarded-credential exemption set

Status: implemented

English | [中文](2026-08-28-forwarded-credential-env-change-control.zh.md)

## Problem

`scrubbedParentEnv` drops every ambient name matching `SENSITIVE_ENV_PATTERN` so the harness's own secrets never reach a spawned child implicitly. Forwarding developer-CLI credentials reopens that boundary for a named list, `FORWARDED_CREDENTIAL_ENV`. A hardcoded exemption list is the kind of surface that grows quietly: one plausible-looking name added to a `Set` literal is a two-line diff that hands a model-driven subprocess a new credential, and neither the diff nor a code comment tells a reviewer what that credential reaches or who agreed to it. Nothing in the repository connected the set to a record, so a reviewer had no way to tell a reviewed addition from an unreviewed one, and a misspelled entry (`NPM_TOKN`) was silently dead rather than loud.

## Decision

`FORWARDED_CREDENTIAL_ENV` is change-controlled by a `doc-sync` gate rather than by convention. The set stays the single source of the names; the per-variable security record — use case, the reach the credential grants any process the model spawns, and the review it landed under — lives in one table on both language sides of [the subprocess subsystem page](../../../../docs/subsystems/subprocess.md), pinned by the rendered-away marker `<!-- forwarded-credential-env -->`. Rationale has one home: the documentation, not a comment beside each entry.

[`verify-forwarded-credential-env`](../../../../scripts/verify-forwarded-credential-env.ts) parses `FORWARDED_CREDENTIAL_ENV` and `SENSITIVE_ENV_PATTERN` out of the seam source with the TypeScript AST — the source plane, with no workspace resolution and no second copy of the regex — and parses each record table from raw table lines, so both language sides grade identically despite translated column headings. It fails on a forwarded name with no row, a row the set no longer holds, a record ordered differently from the declaration, an empty use-case, risk, or review cell, and an entry that is not upper-case or does not match `SENSITIVE_ENV_PATTERN`. Those last two are the typo checks: `scrubbedParentEnv` consults the set only for upper-cased names the pattern already matched, so an entry failing either test is dead code that a reader would still read as an active exemption.

The gate joins `docSyncLeafGates` in [scripts/run-gates.ts](../../../../scripts/run-gates.ts), so it runs in `doc-sync`, `check-all`, and the `ci-primary` aggregate that blocks a pull request. Its acceptance paths are proved to reject in [scripts/verify-forwarded-credential-env.spec.ts](../../../../scripts/verify-forwarded-credential-env.spec.ts), which also grades the live repository record.

## Alternatives considered

- **A `CODEOWNERS` entry requiring security-team approval on the seam file** — GitHub silently ignores an owner that does not resolve, so inventing a team handle would install a control that looks enforced and is not. Review routing is a repository-administration decision, not something this change can assert; the gate blocks the merge regardless of who reviews.
- **A checklist item in the pull-request template** — unconditional noise on every pull request, and a checkbox is self-attested. The gate only speaks when the set actually changes.
- **Per-entry rationale comments beside each `Set` member** — puts the security record in two homes once the documentation also describes the set, and comments are invisible to a reader browsing the subsystem page. The gate keeps the one home honest instead.
- **Importing the constant into the gate instead of parsing the source** — `@deepseek-ai/dsh-subprocess` is neither a root dependency nor a `tsconfig.base.json` path alias, so importing it would mean adding a root dependency to run a documentation check, and it would grade the artifact plane when every sibling doc gate grades source.
- **A dedicated `docs/credentials.md` page** — a new bilingual page plus sidecar and site projection for one table, splitting the environment-scrub story away from the seam that owns it.

## Consequences

- Adding, renaming, or removing a forwarded credential now costs a documented row on both language sides and fails `doc-sync` and CI until it exists; the review reference is a required cell, so an unreviewed addition is visibly incomplete rather than invisible.
- `FORWARDED_CREDENTIAL_ENV` must stay a `new Set([...])` over plain string literals and `SENSITIVE_ENV_PATTERN` a regular-expression literal; the gate throws a naming diagnostic rather than reporting an empty set if either is restructured or renamed.
- The record's ordering is pinned to the declaration order, so a review diff of the code and the table line up row for row.
- Enforcement covers documentation completeness and liveness, not whether an exemption is *justified*. Whether a credential belongs in the set at all remains a review judgment, informed by the reach column the gate now guarantees exists.
