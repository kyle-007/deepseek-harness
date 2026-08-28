# Subprocess

English | [中文](subprocess.zh.md)

The subprocess seam is split across a Service Definition ([dsh-subprocess](../../packages/subprocess/subprocess), `ctx.subprocess`) and Service Provider ([dsh-subprocess-local](../../packages/subprocess/subprocess-local)); its Consumers are other capability seams and out-of-process backends: the [bash executor family](shell.md) uses collected batch output, LSP uses raw protocol pipes, the PTY backend uses the terminal primitive, and the ACP subagent backend uses piped ndjson plus inherited stderr. This seam owns the managed `DSH_*` environment namespace, the shared credential scrub (`scrubbedParentEnv`), and the `CollectedOutput` shape; [dsh-shell](../../packages/shell/shell) re-exports the vocabulary so bash consumers keep one import root.

Source: [`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts) and [`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts)

## Executable lookup

One provider's spawn working directories, executable paths, ordinary processes, and terminal sessions inhabit the same path and process namespace as the mounted filesystem provider. `resolveExecutable(command, env?, signal?)` verifies absolute executable paths or resolves bare names through the provider's scrubbed `PATH` plus deliberate overrides.

## Managed environment namespace and captured output

`DSH_*` variables are Harness-owned child-process facts; implementations discard ambient `DSH_*` names before the caller's explicit `env` merges, so a current fact arrives only as a deliberate string entry, while an explicit `undefined` tombstone removes an ordinary ambient value. Each collected stream reports its truncation and spill-recovery state through `CollectedOutput`.

```ts type-equiv
/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`
```

```ts type-equiv
/** Trusted DeepSeek Harness variables for one child-process execution. */
type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>
```

```ts type-equiv
/** One captured stream: the (possibly truncated) text plus recovery info. */
interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}
```

## Forwarded developer-CLI credentials

`SENSITIVE_ENV_PATTERN` (`/KEY|PASSWORD|SECRET|TOKEN/i`) drops every credential-shaped ambient name from the child base, so the harness's own `DEEPSEEK_API_KEY` never reaches a spawned process implicitly. `FORWARDED_CREDENTIAL_ENV` is the closed exemption list: names that survive the scrub because the developer CLIs a tool call reaches for most often authenticate from the ambient environment and stop at an interactive login prompt once their token is gone, which reads to the model as a hung command.

Every exempted name hands real reach to any process the model spawns, so the set carries a per-variable record here. Adding, renaming, or removing an entry is a change to a security boundary: it lands with its row on both language sides, a named review in the last column, and the [`verify-forwarded-credential-env` gate](../../scripts/verify-forwarded-credential-env.ts) green. That gate reads the set and the pattern out of the seam source, rejects any name the record omits (and any row the set no longer holds), rejects an empty use-case, risk, or review cell, and rejects an entry that is not upper-case or does not match `SENSITIVE_ENV_PATTERN` — such an entry is dead, because `scrubbedParentEnv` consults the set only for upper-cased names the pattern already matched, and a misspelling is the usual cause.

<!-- forwarded-credential-env -->

| Variable | Forwarded so that | Reach granted to any process the model spawns | Reviewed under |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | `gh`, `git` credential helpers, and Actions-shaped tooling authenticate GitHub API and push traffic instead of stopping at `gh auth login`. | Every API call and repository write the token's scopes allow, across other repositories and organization data — not only the checked-out repository. | [Exemption review][credential-review] |
| `GH_TOKEN` | The `gh` CLI checks this name before `GITHUB_TOKEN`, so a session that sets only this one would still reach the login prompt. | Identical to `GITHUB_TOKEN`; the two names are interchangeable inputs to the same credential. | [Exemption review][credential-review] |
| `NPM_TOKEN` | `npm` and `pnpm` substitute it into `.npmrc` to fetch private packages and to publish; without it installs fail outright rather than prompting. | Read and publish rights on every package the token's scopes cover, so a compromise reaches downstream consumers through a published version. | [Exemption review][credential-review] |
| `AWS_ACCESS_KEY_ID` | One third of the ambient credential triple the AWS SDKs and CLI read; any missing part fails with `Unable to locate credentials`. | An identifier rather than a secret on its own; paired with the secret key it carries the principal's full IAM permissions. | [Exemption review][credential-review] |
| `AWS_SECRET_ACCESS_KEY` | The signing secret of that triple, without which no AWS request can be signed. | The principal's full IAM permissions in every region and every account its roles can assume, typically without an expiry. | [Exemption review][credential-review] |
| `AWS_SESSION_TOKEN` | The third element of temporary SSO or assumed-role credentials; omitting it makes the other two invalid rather than merely unauthenticated. | The assumed role's permissions until the session expires — the bounded lifetime is what makes this the preferred AWS shape. | [Exemption review][credential-review] |
| `DOCKER_PASSWORD` | `docker login --password-stdin` wrappers and registry helpers read it, so a `docker push` does not stop at an interactive password prompt. | Pull and push on every repository the registry account can write, so a compromise can publish images downstream consumers run. | [Exemption review][credential-review] |

[credential-review]: ../../.agents/notes/implemented/process/2026-08-28-forwarded-credential-env-change-control.md

## Node-shaped stdio dispositions

Each stream's disposition is explicit, chosen per consumer: raw pipes for protocol framing (LSP JSON-RPC, ACP ndjson), inherit for pass-through diagnostics, and collect mode for bounded batch output — with the spill file optional, so a diagnostic tail (a language server's stderr) buffers without leaving files behind.

```ts type-equiv
/**
 * stdin disposition. `'ignore'` leaves fd 0 on `/dev/null`; `'pipe'` exposes
 * {@link SubprocessHandle.stdin} for the caller's ongoing protocol writes;
 * `{ data }` writes the bytes and closes (the batch shape).
 */
type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
```

```ts type-equiv
/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape (a language server's stderr); including it makes
 * the complete stream recoverable up to its cap (the bash tool shape).
 */
interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}
```

```ts type-equiv
/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through (child diagnostics land on the harness's own stream); a
 * {@link SubprocessCollect} object buffers boundedly with offset-based reads.
 */
type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
```

```ts type-equiv
/** Per-stream stdio dispositions, all explicit — this seam applies no defaults. */
interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}
```

## The fully-explicit spawn spec

The seam applies no defaults: every disposition, limit, and directory is explicit on the spec, so the caller's own config — not a hidden subprocess-service default — decides them. `argv` is never shell-interpreted.

```ts type-equiv
/**
 * A fully-specified spawn request. This seam applies no defaults: every
 * disposition, limit, and directory is explicit, so the caller's own config —
 * not a hidden subprocess-service default — decides them (the `dsh-shell`
 * request/spec split is the owning template).
 */
interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Per-stream stdio dispositions. */
  stdio: SubprocessStdio
  /**
   * Positive finite grace period in milliseconds, no greater than
   * `MAX_TIMER_DELAY_MS`, for the {@link SubprocessHandle.terminate} escalation
   * and for draining still-open collected pipes after the process exits (an
   * inherited descriptor held by a surviving descendant cannot hold the
   * outcome open indefinitely).
   */
  graceMs: number
  /**
   * Abort signal — starts the terminate escalation on the process tree when
   * it fires. The caller owns deadlines and cause classification; this seam
   * only reacts to the abort.
   */
  signal?: AbortSignal | undefined
  /**
   * Explicit environment entries merged onto the implementation's scrubbed
   * parent base (see `scrubbedParentEnv`), with no namespace validation. A
   * string is a deliberate caller opt-in, so a forwarded credential-shaped
   * entry or current `DSH_*` fact survives the scrub; `undefined` is a
   * tombstone that removes an ordinary ambient entry from the child.
   */
  env?: NodeJS.ProcessEnv | undefined
}
```

## Handles: streams, readers, and tree-scoped termination

A spawn returns a live handle immediately. Collect-mode readers take whole-stream byte offsets and never consume, so independent readers cannot steal one another's deltas; piped streams belong to the caller. Termination is tree-scoped on every platform: `terminate()` — the only termination verb — escalates SIGTERM→grace→SIGKILL, and `waitForExit()` observes the whole tree — enough for a consumer to build its own teardown ladder (the ACP backend's stdin-EOF-first `disposeAcpChild` is the template).

```ts type-equiv
/**
 * A live child process rooted in its own process tree. Collected output
 * remains readable after exit; piped streams belong to the caller.
 *
 * Termination is tree-scoped everywhere: POSIX signals the detached process
 * group (falling back to the direct child when the group is gone), Windows
 * terminates the tree via `taskkill /T`, so helper processes cannot outlive
 * the handle unnoticed.
 */
interface SubprocessHandle {
  /** Process id (tree root); -1 when the spawn itself failed. */
  readonly pid: number
  /** The child's stdin, present iff spawned with `stdin: 'pipe'`. */
  readonly stdin: Writable | undefined
  /** The child's raw stdout, present iff spawned with `stdout: 'pipe'`. */
  readonly stdout: Readable | undefined
  /** The child's raw stderr, present iff spawned with `stderr: 'pipe'`. */
  readonly stderr: Readable | undefined
  /** Offset-based readers for collect-mode streams (also readable after exit). */
  readonly collected: SubprocessCollectedOutputs
  /** Resolves at process close with exit facts; rejects only for spawn-level failures. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Begin the SIGTERM → `graceMs` → SIGKILL escalation on the process tree
   * (Windows force-terminates immediately) — the seam's only termination
   * verb. Idempotent, a no-op once the tree is gone (the pid may be reused),
   * and also triggered by the spec's abort signal.
   */
  terminate(): void
  /**
   * Wait until the process tree has exited — the tree, not just the direct
   * child, so a still-running helper is observable before teardown returns.
   * @param signal - optional bound for the wait.
   * @returns `true` when the tree exited, `false` when the signal aborted first.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
```

```ts type-equiv
/**
 * Cursor-free incremental access to one collected output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output; `readFrom(0)` after settlement is the
 * batch result (`lossy` then means the in-memory tail lost its head — the
 * {@link CollectedOutput.truncated} fact).
 */
interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): SubprocessOutputRead
}
```

```ts type-equiv
/** One incremental {@link SubprocessOutputReader.readFrom} read. */
interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}
```

```ts type-equiv
/** Offset-based readers for the streams spawned in collect mode. */
interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}
```


## Outcomes carry exit facts only

`done` reports Node's close-event vocabulary and no cause classification — the service kills on abort but never decides why (the caller reads the deadline signal it owns, e.g. the bash executor's `timedOut`/`aborted` split). Collected output stays readable through `handle.collected` after settlement, so batch and streaming callers share one access path.

```ts type-equiv
/**
 * Exit facts of one closed process — Node's `close`-event vocabulary.
 * Deliberately carries NO timeout or cancellation classification (the caller
 * reads the signal it owns to classify causes) and NO output: collected
 * streams stay readable through {@link SubprocessHandle.collected} after
 * settlement, so batch and streaming callers share one access path.
 */
interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}
```

## Terminal-process primitive

`spawnTerminal(spec)` is the non-pipe process primitive. The provider allocates the controlling terminal and owns UTF-8 text transport, foreground-process-group inspection and signalling, and one awaited TERM-to-KILL operation that reaches quiescence for every session member the provider can still observe; providers document substrate-specific observability limits. The PTY backend remains responsible for prompt detection, readiness inference, scrollback, sandbox policy, and persistent-session ownership; ordinary `spawn()` cannot reconstruct controlling-terminal semantics.

The terminal spec fully specifies argv, cwd, environment overrides, dimensions, cleanup grace, and optional allocation cancellation. Its handle exposes `pid`, ordered output, `done`, `write`, `inspectForeground`, `signalForeground`, and awaited `terminate`; the exact public shapes are generated into the [`ctx.subprocess` service catalog](#ctxsubprocess--subprocessruntime-abstract-seam).

## Service behavior

The abstract [`SubprocessRuntime`](../../packages/subprocess/subprocess/src/index.ts) Service Definition specifies execution-world coordinates, executable lookup, ordinary `spawn`, and `spawnTerminal`. [`LocalSubprocessRuntime`](../../packages/subprocess/subprocess-local/src/index.ts) provides them with detached process trees, per-disposition wiring, credential scrubbing, `node-pty`, platform process inspection, and terminate-and-join disposal. See [`dsh-subprocess`](../../packages/subprocess/subprocess/README.md) for the Service Definition contract and [`dsh-subprocess-local`](../../packages/subprocess/subprocess-local/README.md) for local mechanics.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxe2b--e2bruntime"></a>

### `ctx.e2b` — `E2BRuntime`

Creates one lazily consumable E2B SDK handle and deletes the sandbox at timeout or disposal. Creation begins at plugin construction; adapters await getSandbox before their first operation.

```ts cordis-catalog
/**
 * Return the shared live SDK handle.
 * @returns the created sandbox after the configured cwd exists.
 * @throws when E2B rejects creation or the service is disposing.
 */
async getSandbox(): Promise<Sandbox>
```

Source: [`packages/e2b/e2b/src/index.ts`](../../packages/e2b/e2b/src/index.ts)

<a id="ctxsubprocess--subprocessruntime-abstract-seam"></a>

### `ctx.subprocess` — `SubprocessRuntime` (abstract seam)

Abstract subprocess service. Subclass, implement spawn, and load the subclass as a plugin — it registers as `ctx.subprocess` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Executable paths belong to one execution world shared with the mounted filesystem provider.
- spawn returns immediately with a live handle; `done` resolves at process close with exit facts and rejects only for spawn-level failures.
- Collect-mode readers are offset-based and non-consuming, so independent readers never consume one another's output; lossy reads report truncation and the spill file holding the complete stream when one exists. Piped streams are handed to the caller raw and never buffered here.
- SubprocessHandle.terminate (and the spec's abort signal) escalates SIGTERM→grace→SIGKILL — the only termination verb — tree-scoped on every platform. SubprocessHandle.waitForExit observes whole-tree liveness, so a consumer-owned teardown ladder can hold each tier on real quiescence.
- Disposal of the service terminates all still-running managed processes and awaits their exit.
- spawnTerminal owns terminal allocation, text transport, foreground groups, signalling, and whole-session quiescence behind one awaited termination method; readiness and persistent-shell policy stay in the PTY consumer. Its output stream ends after queued terminal output when the top-level process exits.

```ts cordis-catalog
/**
 * Resolve one configured executable in this provider's execution world.
 * Absolute paths are verified; bare names use the provider's scrubbed PATH
 * plus explicit environment overrides. Relative paths containing separators
 * are rejected: the resolution base is undefined, so providers fail loud
 * instead of guessing.
 * @param command - absolute executable path or bare PATH name.
 * @param env - explicit environment entries used for lookup.
 * @param signal - aborts remote or local lookup.
 * @returns a canonical executable path.
 */
abstract resolveExecutable( command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, ): Promise<string>

/**
 * Start one managed child process from a fully-specified spec; this seam
 * applies no defaults.
 * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
 * @returns the live process handle (streams/readers, signalling, outcome promise).
 */
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle

/**
 * Allocate a real terminal and start one owned process session. This is the
 * only non-pipe process primitive: implementations own terminal byte I/O,
 * foreground groups, signals, and complete session-tree cleanup.
 * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
 * @returns the live terminal handle after allocation succeeds.
 */
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

Source: [`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts)
<!-- END GENERATED cordis-surface -->
