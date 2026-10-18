# Agent Note: Bounded shell scans and job reminders

Status: implemented

English | [中文](2026-10-18-bounded-shell-scans-and-job-reminders.zh.md)

## Problem

A session ran `grep -rn ci_scope --include=* .` in a repository of about 192 GB whose `target/` alone held about 82 GB. The shipped foreground deadline for `bash` is 60 s — the `bash-sandbox` row of [`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml) sets the executor's `timeoutMs: 60000` — while [`dsh-tool-bash`](../../../../packages/shell/tool-bash/src/index.ts) defaulted `promoteOnTimeout` to true. On expiry the command was detached into an unsupervised `ctx.jobs` job instead of being stopped. It kept reading 140–234 MB/s and holding a CPU core for 5.5 minutes until a human killed it, with package temperature at 94 °C against a 100 °C Tjmax.

Three gaps let that command cost what it did. Nothing inspected shell command text — a search over `packages/**/src` finds no command-shape policy — so a recursive `grep` over build trees looked like any other command. The promoted result carried no resource evidence, so the model could not tell the job was expensive. And the one bounded content-search path in the product, the [`grep` tool](../../../../packages/fs/tool-fs-search/src/grep.ts) with its ripgrep backend, ignore-file honoring, 30 s budget, 250-match cap, and 20 MB raw-output cap, was not signposted in the `bash` tool description.

## Decision

Four parts ship together.

**A command-shape denial.** [`packages/guard/unbounded-scan-guard`](../../../../packages/guard/unbounded-scan-guard/src/index.ts) registers a monotonic guard with `ctx.tools.guard()` on the configured tools (default `['bash']`). It splits the command string into top-level segments, classifies each as a tree-wide walk — a `grep`-family command that recurses (`-r`, `-R`, `--recursive`), `find` without `-maxdepth`/`-prune`, `du` without `--max-depth`, `rg`/`ripgrep` with its ignore files disabled — resolves the path operands against the call's working directory, and denies the call when a resolved scan root holds a configured heavy directory (default `node_modules`, `target`, `.git`, `.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `vendor`, `.wt`). Exclusions the command already carries (`--exclude-dir`, `--exclude`) clear the denial for the directory they name. The denial names the offending segment, the roots, the blocking directories, a corrected command for the `grep` family, and the `grep` tool as the bounded alternative. The [tools subsystem reference](../../../../docs/subsystems/tools.md) owns the guard slot's semantics and position in the execution pipeline.

**A long-job reminder.** [`packages/guard/long-job-reminder`](../../../../packages/guard/long-job-reminder/src/index.ts) listens on `agent/pre-step` and prepends one logged notice when the agent owns jobs that have run past `remindAfterMs` (default 120000), longest first and capped at `maxListed` (default 5). The message declares source kind `long-job-reminder` and form `notice` with a summary, which the [context form vocabulary](../feature/2026-08-05-context-form-vocabulary.md) defines; its text names `job_output` and `job_kill` as the actions that end the situation. A job is reported once.

**A foreground deadline that stops the command.** Every shipped `tool-bash` and `tool-pwsh` row sets `config.promoteOnTimeout: false`, in the base bundle and in the three `web-app` presets. A foreground command that reaches its deadline is killed and reported rather than detached, and `promoteOnTimeout` keeps its `true` plugin default for a composition that wants promotion. Work that legitimately needs longer declares itself with `run_in_background` or a larger `timeoutMs`, which the parameter description states.

**The bounded path in model-facing text.** The `bash` and `pwsh` tool descriptions name the `grep` tool and the cost of an unbounded recursive search — the pwsh description also names `Select-String` and `Get-ChildItem -Recurse` — and the promoted result text for both tools states that a detached command keeps consuming CPU and disk and points at the bounded search.

## Testing

The two packages' specs cover their behavior directly. [`unbounded-scan-guard.spec.ts`](../../../../packages/guard/unbounded-scan-guard/tests/unbounded-scan-guard.spec.ts) covers the segment grammar, each inspected tool's bound and exclusion facts, the denial text, and the policy through a real tool registry; [`long-job-reminder.spec.ts`](../../../../packages/guard/long-job-reminder/tests/long-job-reminder.spec.ts) covers duration and listing text and the due rule, including the once-only report. Each package also has a real Loader composition test that boots a test-only `cordis.yml`, mounts the plugin, and observes the denial or the injected message.

The refreshed recorded-session fixtures pin the changed model-visible text: the tool-schema expectations across the session corpus carry the new `bash` description and `timeoutMs` parameter text, and `snapshots/session/bash-startup-timeout/` records a foreground command that settles as `[timed out after 1ms]` and `[killed by signal: SIGTERM]` instead of a promoted job. The `pwsh` description is pinned by the `platform: pwsh` scenario [`snapshots/session/pwsh-tool-turn/`](../../../../snapshots/session/pwsh-tool-turn/snapshot.yml), which replays only where a `pwsh` host is available; its recorded schema carries the updated description, edited in place because the recording host here has no `pwsh`. The persistent tool that [`snapshots/session/persistent-pwsh-tool-turn/`](../../../../snapshots/session/persistent-pwsh-tool-turn/snapshot.yml) pins kept its own description, so that scenario needed no update. Two authored compaction-budget scenarios, `snapshots/session/compaction-output-reserve/` and `snapshots/session/compaction-summary-headroom/`, needed their pinned context window re-tuned: the larger tool schema moves the proactive compaction trigger, so each composition keeps exactly one compaction between the replayed history and its replacement. The denial's recorded-session coverage is the authored headless scenario in [`snapshots/session/scan-guard-denial/`](../../../../snapshots/session/scan-guard-denial/snapshot.yml), which replays a denied scan through a shipped profile and pins the denial as the model-visible result.

## Alternatives considered

**Sample child CPU and I/O to detect a runaway at runtime.** The signal would come from the process itself rather than from the command text, but reading it needs platform-specific machinery — `/proc` on Linux, `/bin/ps` on macOS, Toolhelp32 on Windows — that this repository does not have, and it has no resource telemetry to compare against. A lexical check needs no new platform surface and refuses the reads before they start.

**Tighten the global foreground deadline.** A shorter default cannot separate a scan from a legitimate build or test run, and the shipped 60 s already fails work that needs minutes. The cost would land on ordinary commands while the expensive shape stays legal.

**Rewrite the command to add exclusions.** A `tools/pre-execute` listener can deny or allow a call but cannot rewrite its arguments, and silently rewriting a command changes what the caller asked for. Synthesizing exclusion flags also requires knowing each inspected tool's flag grammar at the rewriting layer.

**Warn after the call.** A `tools/post-execute` warning arrives when the expensive reads have already finished. The denial exists to prevent that work, not to explain it afterwards.

## Consequences

An unbounded scan over a heavy tree is refused before it starts, a detached job is announced while the agent can still collect or stop it, and a foreground command that reaches its deadline stops instead of running on unsupervised. Content search reaches the `grep` tool through the `bash` and `pwsh` descriptions and through the denial itself, so the bounded path is the one the model is told about.

Detection is a lexical command-string heuristic: a nested shell, a script file, a variable-expanded path, or an unlisted tool carries a scan the policy never sees, because nothing is executed to find out. Heavy-directory detection is name-based, so any directory carrying a configured name blocks the scan and a small same-named directory is denied too. The probe reads the harness's own filesystem, so a scan whose execution world is remote or sandboxed is approximated rather than inspected and the policy fails open there.

Killing at the deadline turns long work that used to be detached into a visible failure: a build or test run past the timeout must now opt in with `run_in_background` or a larger `timeoutMs`, and only a deployment that sets `promoteOnTimeout: true` keeps promotion. The reminder never bounds or kills a job and fires only when the agent proposes another step, so a session that ends its turn leaves a running job unmentioned.
