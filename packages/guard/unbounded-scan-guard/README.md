---
description: "Shell scan policy that denies tree-wide grep, find, du, and ripgrep calls whose starting directory holds build or dependency trees, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-unbounded-scan-guard

English | [中文](README.zh.md)

## Summary

Use this package to keep tree-wide shell searches from reading gigabytes of build, dependency, or repository data. Before a configured tool call runs, the policy classifies the command and denies a recursive `grep`, `find`, `du`, or `rg` whose starting directory holds a heavy directory; the model receives the blocking directory names and a narrowed command to run instead. A denied call never executes. Scans that already bound the walk, or that exclude every heavy directory, pass through untouched. The `dsh` base bundle enables the package with the default directory list.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a shell search could start at a directory that holds build, dependency, or repository trees. The `dsh` base bundle already runs it with the default directory list; tune the list or the inspected tools below when your layout differs.

### When to choose it

Choose it when agents search trees whose contents you know, and one careless `grep -rn` over `node_modules`, `target`, or `.git` would cost minutes of CPU and gigabytes of reads. Avoid it when the model needs unrestricted shell search — a denial forces the narrowed command instead — and when searches reach the filesystem through a path the policy does not read: `bash` is the default inspected tool, so a Windows PowerShell tool, a scan inside a script, or a variable-expanded root is not checked.

### Setting the policy

Mount the plugin with no configuration to accept both defaults:

```yaml
- name: '@deepseek-ai/dsh-unbounded-scan-guard'
```

| Field | Default | Meaning |
|---|---|---|
| `heavyDirectories` | `['node_modules', 'target', '.git', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'vendor', '.wt']` | Directory names that make a scan of their parent unbounded; a name that exists nowhere under a scan root never triggers a denial |
| `tools` | `['bash']` | Tool names whose calls are inspected; another shell consumer needs its own command grammar before it can be listed here |

Invalid configuration fails at plugin load: a `heavyDirectories` entry that is empty, whitespace-only, or contains `/`, and an empty `tools` list. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-unbounded-scan-guard) is the exhaustive source for every accepted field.

### What you get

A `bash` call is split into top-level segments, and each segment is classified on its own. A `grep` (`egrep`, `fgrep`, `ggrep`) that recurses, a `find` without `-maxdepth` or `-prune`, a `du` without `--max-depth`/`-d`, or `rg` that disables ignore files counts as an unbounded walk. For one, the policy resolves every path operand against the call's working directory — the call's own `workdir`, else the session directory, else the process directory — drops operands that are not existing directories, and removes directories the command already excludes. If any root still holds a configured name, the call is denied before it runs and the model reads `Error: <reason>` as an error result instead of the tool's output. The reason names the offending segment, the roots, the blocking directories, the narrowed command, and the `grep` tool; the first offending segment of a call decides that text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the policy reads a command and decides, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The policy is built on four commitments:

- **Lexical, never a shell.** The command string is read as words, quotes, and top-level operators; nothing is executed, expanded, or resolved through a shell. A construct the grammar cannot see is simply not classified.
- **One segment at a time.** Segments split on `;`, `|`, `||`, `&&`, and newlines, so a scan later in a compound call is judged exactly like a scan alone.
- **Local probe, fail open.** A scan root is probed with `statSync` on the harness's own filesystem; an absent, unreadable, or non-directory path cannot be the protected tree, so the call proceeds.
- **Monotonic guard.** The policy registers on `ctx.tools.guard()`, so no later listener can turn its denial back into permission, and a call to an uninspected tool costs one set lookup and no filesystem work.

### What counts as an unbounded walk

Each inspected command carries its own bound and exclusion facts.

- **`grep` family.** Recursion comes from `-r`, `-R`, `--recursive`, `--dereference-recursive`, or `-d recurse`; `--exclude-dir`/`--exclude` values (inline or separate, `=`-joined or not) record exclusions. The first bare operand is the pattern unless `-e`/`-f`/`--regexp`/`--file` supplied one, so it is never mistaken for a path.
- **`find`.** `-maxdepth` and `-prune` make the walk bounded; `!`, `(`, and every option word are skipped when operands are collected.
- **`du`.** `--max-depth`/`-d` makes the walk bounded; `--exclude-dir`/`--exclude` record exclusions.
- **`rg`/`ripgrep`.** ripgrep honors ignore files by default, so only an ignore-disabling form (`-u` clusters, `--no-ignore*`) counts as unbounded.

Command prefixes (`sudo`, `env`, `time`, `nohup`, `nice`, `ionice`, `stdbuf`), `VAR=value` assignments, and any path-qualified command word are skipped to find the command each segment invokes. A scan with no path operand starts at the working directory.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, `splitSegments`/`scanIntent`/`denialReason`, the `tools.guard()` registration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tool-call pipeline to the enforced guard semantics, the recommended alternative tool, and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` pipeline and the monotonic guard slot this policy registers into.
- [Tool catalog: `grep`](../../../docs/tool-catalog.md#grep) — the model-facing tool the denial recommends in place of an unbounded shell search.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-unbounded-scan-guard) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Denied tool call

#### What the model sees

Nothing until a call is denied. A denied call never runs and produces no normal result; the model instead receives the registry's denial result for that call — one text block `Error: <reason>` with `isError: true` — in place of the tool's own output. The template below is that whole reason: `<command>` is the offending segment, `<roots>` the roots it would search, `<directories>` the configured names that exist under them written as `<name>/`, and `<remedy>` either the same command followed by one `--exclude-dir=<directory>` flag per blocking name, or, for `find`, `du`, and `rg`, a sentence naming that tool's own bound (the `-maxdepth`/`-prune` forms for `find`, the `--max-depth`/`--exclude` forms for `du`). The closing sentence points at the `grep` tool, which honors ignore files and is bounded by its own timeout and result caps.

##### Denial reason template

```markdown
Blocked a tree-wide scan: `<command>` searches <roots>, which holds <directories>. Those directories hold build, dependency, or repository data; walking them reads gigabytes and can hold a CPU core for minutes. <remedy> The grep tool searches with ripgrep, honors ignore files, and is bounded by its own timeout and result caps.
```

#### Token effect

Zero tokens for calls the policy does not deny. A denial adds one retained error result instead of the tool output the call would have produced; its length is bounded by the command segment and the directory names it quotes.

#### KV Cache effect

Append-only; a denial replaces only the new result for that call, after the reusable request prefix, so it does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **A lexical command string is the whole input** — the policy reads words, quoting, and top-level operators, so a scan it cannot see (a nested shell, a script file, a variable-expanded path, an unlisted tool) is never denied.
- **The probe is local** — roots are probed on the harness's own filesystem, so a scan whose execution world is remote or sandboxed is approximated rather than inspected, and the policy fails open.
- **Heavy-directory detection is name-based** — every directory carrying a configured name blocks the scan, so a same-named small directory is denied too; there is no size or file-count check.
- **Only the configured tools are inspected** — `bash` by default, so Windows PowerShell commands are out of scope today; another shell consumer needs its own command grammar before it can join `tools`.
- **Exclusions match by basename only** — `--exclude-dir`/`--exclude` values are reduced to their last path segment, so an exclusion such as `build/node_modules` clears the denial for a top-level `node_modules` the command still walks.
- **One denial per call** — the first offending segment decides the message, and later segments of the same command are not reported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The `dsh` base bundle composes this plugin as the `unbounded-scan-guard` row of `packages/bundle/base/cordis.patch.yml` with no inline config, so both defaults above are what ships. The [guard group map](../README.md) owns the family view, and the [tools subsystem reference](../../../docs/subsystems/tools.md) owns the monotonic guard semantics this policy registers into. Open questions: whether a size- or file-count-based probe should replace the name list, and what command grammar a Windows PowerShell tool would need before it could join `tools`.

</details>
