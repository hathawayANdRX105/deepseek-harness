/**
 * Shell scan policy: deny a tree-wide search whose starting directory holds
 * build or dependency trees. GNU `grep -r`, `find`, and `du` walk those trees
 * without honoring ignore files, so one call can read tens of gigabytes and
 * hold a CPU core for minutes; the model is told which directories triggered
 * the denial and which narrowed form to run instead. Configuration and the
 * shortcuts this policy deliberately misses live in the package README.
 * @module @deepseek-ai/dsh-unbounded-scan-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

export const name = 'unbounded-scan-guard'

/** The tool registry the monotonic guard registers on. */
export const inject = ['tools']

/**
 * Plugin configuration. Every list is deployment policy: the defaults cover
 * the trees this repository's own workloads produce, and a composition that
 * knows its own layout replaces them from cordis.yml.
 */
export interface Config {
  /**
   * Directory names that make a scan of their parent unbounded (default
   * `['node_modules', 'target', '.git', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'vendor', '.wt']`).
   * A name that exists nowhere under a scan root never triggers a denial.
   */
  heavyDirectories?: string[]
  /**
   * Tool names whose calls are inspected (default `['bash']`). Another shell
   * consumer (a PowerShell tool, a remote executor) needs its own command
   * grammar before it can be listed here.
   */
  tools?: string[]
}

export const Config: z<Config> = z.object({
  heavyDirectories: z.array(z.string()).default([
    'node_modules', 'target', '.git', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'vendor', '.wt',
  ]),
  tools: z.array(z.string()).default(['bash']),
})

/** One unquoted shell word plus the position it came from, so a denial can quote the segment verbatim. */
interface Word {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** One top-level pipeline segment: its words and its exact source text. */
interface Segment {
  readonly words: readonly Word[]
  readonly text: string
}

/** What kind of unbounded walk one segment performs, and what it walks. */
interface ScanIntent {
  /** The command word that performs the walk (`grep`, `find`, `du`, `rg`). */
  readonly tool: string
  /** Path operands, in command order; empty means the walk starts at the working directory. */
  readonly roots: readonly string[]
  /** Directory names the command already excludes, from `--exclude-dir`, `--exclude`, and `-prune`. */
  readonly excluded: readonly string[]
  /** Whether the command bounds the walk by depth or prunes it, which makes it scannable. */
  readonly bounded: boolean
}

/** Command words whose only job is to modify the following command's environment or priority. */
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'nice', 'ionice', 'stdbuf'])

/** `grep`-family command words that honor `--exclude-dir` and walk recursively. */
const GREP_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'ggrep'])

/** Options whose value is the next word, so the value is never mistaken for a path operand. */
const GREP_OPTIONS_TAKING_A_WORD = new Set([
  '-e', '-f', '-d', '-m', '-A', '-B', '-C',
  '--regexp', '--file', '--directories', '--exclude', '--exclude-dir', '--include', '--include-dir',
  '--binary-files', '--devices', '--label', '--after-context', '--before-context', '--context', '--max-count',
])

/** Options that supply the pattern, so the first remaining operand is a path rather than the pattern. */
const GREP_PATTERN_OPTIONS = new Set(['-e', '-f', '--regexp', '--file'])

/** `rg` flags that disable the ignore files which keep a ripgrep search bounded. */
const RIPGREP_IGNORE_DISABLERS = new Set(['-u', '-uu', '-uuu', '--no-ignore', '--no-ignore-vcs', '--no-ignore-parent', '--no-ignore-global', '--no-ignore-dot'])

/**
 * Split a shell command into top-level pipeline segments and their unquoted
 * words. Quoting, escaping, and control operators are the whole grammar: the
 * policy reads one operator-free segment at a time, so a scan later in a
 * compound command is judged exactly like a scan alone.
 * @param command - the raw `bash -c` command string.
 * @returns one entry per segment, in source order, each with its source text.
 */
export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = []
  let words: Word[] = []
  let wordStart = -1
  let segmentStart = 0
  let quote: '"' | "'" | undefined
  let current = ''

  const endWord = (end: number): void => {
    if (wordStart < 0) return
    words.push({ text: current, start: wordStart, end })
    current = ''
    wordStart = -1
  }
  const endSegment = (end: number, nextStart: number): void => {
    endWord(end)
    if (words.length > 0) segments.push({ words, text: command.slice(segmentStart, end).trim() })
    words = []
    segmentStart = nextStart
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string
    if (quote === "'") {
      if (character === "'") quote = undefined
      else current += character
      continue
    }
    if (character === '\\') {
      const escaped = command[index + 1]
      if (escaped !== undefined) {
        if (wordStart < 0) wordStart = index
        current += escaped
        index += 1
        continue
      }
    }
    if (quote === '"') {
      if (character === '"') quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      if (wordStart < 0) wordStart = index
      quote = character
      continue
    }
    if (character === ' ' || character === '\t' || character === '\n') {
      endWord(index)
      if (character === '\n') endSegment(index, index + 1)
      continue
    }
    if ((character === '&' && command[index + 1] === '&') || (character === '|' && command[index + 1] === '|')) {
      endSegment(index, index + 2)
      index += 1
      continue
    }
    if (character === ';' || character === '|') {
      endSegment(index, index + 1)
      continue
    }
    if (wordStart < 0) wordStart = index
    current += character
  }
  endSegment(command.length, command.length)
  return segments
}

/**
 * The command word a segment invokes, after skipping `VAR=value` assignments
 * and commands that only prefix another one (`sudo`, `env`, `time`).
 * @param words - the segment's words.
 * @returns the command word and its index, or `undefined` for an assignment-only segment.
 */
function commandWord(words: readonly Word[]): { text: string; index: number } | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const text = (words[index] as Word).text
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(text)) continue
    if (COMMAND_PREFIXES.has(basename(text))) continue
    return { text, index }
  }
  return undefined
}

/** Whether one `grep` option cluster requests recursion (`-r`, `-R`, `-rn`, `--recursive`). */
function grepRecurses(option: string): boolean {
  if (option === '--recursive' || option === '--dereference-recursive') return true
  if (!/^-[A-Za-z]+$/u.test(option)) return false
  return /[rR]/u.test(option.slice(1))
}

/** The value of `--name=value` in one option word, or `undefined`. */
function inlineOptionValue(option: string): string | undefined {
  const separator = option.indexOf('=')
  return separator < 0 ? undefined : option.slice(separator + 1)
}

/**
 * The directory names one option word excludes, from `--exclude-dir=PATH`,
 * `--exclude-dir PATH`, `--exclude=GLOB`, and a following `--exclude GLOB`.
 * @param option - one option word.
 * @param next - the following word, used when the option takes its value separately.
 * @returns the excluded directory names, or an empty list for an unrelated option.
 */
function excludedByOption(option: string, next: string | undefined): string[] {
  const inline = inlineOptionValue(option)
  const name = inline === undefined ? option : option.slice(0, option.indexOf('='))
  if (name !== '--exclude-dir' && name !== '--exclude') return []
  const value = inline ?? next
  if (value === undefined) return []
  const trimmed = value.replace(/^['"]|['"]$/gu, '').replace(/\/+$/u, '')
  return trimmed.length === 0 ? [] : [basename(trimmed)]
}

/** The text of the word that follows `index`, when the command supplies one. */
function nextWordText(pairs: readonly Word[], index: number): string | undefined {
  const next = pairs[index + 1]
  return next === undefined ? undefined : next.text
}

/** Collect the path operands and exclusion facts of one `grep` segment. */
function grepIntent(words: readonly Word[], commandIndex: number): ScanIntent {
  const pairs = words.slice(commandIndex + 1)
  const operands: Word[] = []
  const excluded: string[] = []
  let recursive = false
  let patternSupplied = false
  for (let index = 0; index < pairs.length; index += 1) {
    const option = (pairs[index] as Word).text
    if (option === '--') {
      operands.push(...pairs.slice(index + 1))
      break
    }
    if (option.startsWith('-') && option !== '-') {
      if (grepRecurses(option)) recursive = true
      if (option === '-d' || option === '--directories') {
        const value = nextWordText(pairs, index)
        if (value !== undefined && /^(recurse|r)$/u.test(value)) recursive = true
      }
      if (GREP_PATTERN_OPTIONS.has(option) || GREP_PATTERN_OPTIONS.has(option.slice(0, option.indexOf('=')))) patternSupplied = true
      const takesWord = GREP_OPTIONS_TAKING_A_WORD.has(option)
      excluded.push(...excludedByOption(option, takesWord ? nextWordText(pairs, index) : undefined))
      if (takesWord) index += 1
      continue
    }
    operands.push(pairs[index] as Word)
  }
  // The first bare operand is the pattern unless an option already supplied one.
  const paths = patternSupplied ? operands : operands.slice(1)
  return { tool: 'grep', roots: paths.map(word => word.text), excluded, bounded: !recursive }
}

/** Collect the path operands and bounding facts of one `find` segment. */
function findIntent(words: readonly Word[], commandIndex: number): ScanIntent {
  const operands: Word[] = []
  let bounded = false
  for (const word of words.slice(commandIndex + 1)) {
    if (word.text.startsWith('-') || word.text === '!' || word.text === '(') {
      if (word.text === '-maxdepth') bounded = true
      if (word.text === '-prune') bounded = true
      continue
    }
    if (bounded) continue
    operands.push(word)
  }
  return { tool: 'find', roots: operands.map(word => word.text), excluded: [], bounded }
}

/** Collect the path operands and bounding facts of one `du` segment. */
function duIntent(words: readonly Word[], commandIndex: number): ScanIntent {
  const pairs = words.slice(commandIndex + 1)
  const operands: Word[] = []
  const excluded: string[] = []
  let bounded = false
  for (let index = 0; index < pairs.length; index += 1) {
    const option = (pairs[index] as Word).text
    if (option.startsWith('-') && option !== '-') {
      if (option === '--max-depth' || option === '-d' || option.startsWith('--max-depth=')) bounded = true
      excluded.push(...excludedByOption(option, nextWordText(pairs, index)))
      continue
    }
    operands.push(pairs[index] as Word)
  }
  return { tool: 'du', roots: operands.map(word => word.text), excluded, bounded }
}

/** Collect the path operands and ignore facts of one `rg` segment. */
function ripgrepIntent(words: readonly Word[], commandIndex: number): ScanIntent {
  const pairs = words.slice(commandIndex + 1)
  const operands: Word[] = []
  let unbounded = false
  for (const word of pairs) {
    if (word.text.startsWith('-') && word.text !== '-') {
      // `--no-ignore` and `-u` clusters appear inside longer clusters (`-uu`, `-un`).
      if (RIPGREP_IGNORE_DISABLERS.has(word.text)) unbounded = true
      if (/^-[a-z]+$/u.test(word.text) && word.text.includes('u')) unbounded = true
      if (word.text.startsWith('--no-ignore')) unbounded = true
      continue
    }
    operands.push(word)
  }
  // ripgrep takes the pattern first, then optional paths.
  const paths = operands.slice(1)
  return { tool: 'rg', roots: paths.map(word => word.text), excluded: [], bounded: !unbounded }
}

/**
 * Classify one segment as an unbounded tree walk, or not a scan at all.
 * @param segment - one operator-free pipeline segment.
 * @returns the scan intent, or `undefined` when the segment is not a scan or already bounded.
 */
export function scanIntent(segment: Segment): ScanIntent | undefined {
  const command = commandWord(segment.words)
  if (command === undefined) return undefined
  const tool = basename(command.text)
  if (GREP_COMMANDS.has(tool)) return grepIntent(segment.words, command.index)
  if (tool === 'find') return findIntent(segment.words, command.index)
  if (tool === 'du') return duIntent(segment.words, command.index)
  if (tool === 'rg' || tool === 'ripgrep') return ripgrepIntent(segment.words, command.index)
  return undefined
}

/** Whether a resolved path is an existing directory; an unreadable or absent path is never a scan root. */
function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Absent, unreadable, or a file: the path cannot be the tree this policy protects.
    return false
  }
}

/** One scan root that holds heavy directories, with the names that were found. */
interface HeavyRoot {
  readonly root: string
  readonly heavy: readonly string[]
}

/** The directories of `heavyDirectories` that exist under one root, in configuration order. */
function heavyUnder(root: string, heavyDirectories: readonly string[]): string[] {
  return heavyDirectories.filter(name => existingDirectory(join(root, name)))
}

/**
 * The directory a call's relative operands resolve against, and the default
 * scan root when the command names none: an explicit `workdir` (absolute, or
 * resolved against the session directory), else the session directory, else
 * the launch directory.
 * @param workdir - the call's `workdir` argument value, if any.
 * @param sessionDirectory - the calling session's directory, when one exists.
 * @returns the absolute directory the command runs in.
 */
export function resolveWorkdir(workdir: unknown, sessionDirectory: string | undefined): string {
  const base = sessionDirectory ?? process.cwd()
  if (typeof workdir !== 'string' || workdir.length === 0) return base
  return isAbsolute(workdir) ? workdir : resolve(base, workdir)
}

/**
 * Build the model-facing denial: which command, which root, which directories
 * blocked it, and the narrowed form to run instead.
 * @param segment - the offending segment's source text.
 * @param intent - its classified scan intent.
 * @param blocked - every root of that scan that holds heavy directories.
 * @returns the denial reason handed to the model, without the `Error: ` prefix the registry adds.
 */
export function denialReason(segment: string, intent: ScanIntent, blocked: readonly HeavyRoot[]): string {
  const names = [...new Set(blocked.flatMap(entry => entry.heavy))]
  const roots = [...new Set(blocked.map(entry => entry.root))].join(', ')
  const scope = `\`${segment}\` searches ${roots}, which holds ${names.map(name => `${name}/`).join(', ')}`
  const cost = 'Those directories hold build, dependency, or repository data; walking them reads gigabytes and can hold a CPU core for minutes.'
  const remedy = intent.tool === 'grep'
    ? `Exclude them and keep the search: ${segment} ${names.map(name => `--exclude-dir=${name}`).join(' ')}`
    : 'Bound the walk before re-running (find: `-maxdepth` or `-prune`; du: `--max-depth` or `--exclude`).'
  const alternative = 'The grep tool searches with ripgrep, honors ignore files, and is bounded by its own timeout and result caps.'
  return `Blocked a tree-wide scan: ${scope}. ${cost} ${remedy} ${alternative}`
}

/**
 * Install the policy as a monotonic tool guard: one denial cannot be turned
 * back into permission by listener order, and a call that is not an inspected
 * shell command passes without any filesystem work beyond the tool-name check.
 * @param ctx - plugin context; the guard is removed with it.
 * @param config - validated {@link Config}; both lists are re-checked here so a
 * bad entry fails at load rather than at the first matching call.
 */
export function apply(ctx: Context, config: Config): void {
  const heavyDirectories = config.heavyDirectories as string[]
  const tools = new Set(config.tools as string[])
  for (const name of heavyDirectories) {
    if (name.trim().length === 0 || name.includes('/')) {
      throw new Error(`unbounded-scan-guard: invalid heavyDirectories entry ${JSON.stringify(name)} — expected a plain directory name`)
    }
  }
  if (tools.size === 0) throw new Error('unbounded-scan-guard: `tools` must name at least one tool')

  ctx.tools.guard((exec) => {
    if (!tools.has(exec.name)) return undefined
    const command = (exec.arguments as { command?: unknown }).command
    if (typeof command !== 'string' || command.length === 0) return undefined
    for (const segment of splitSegments(command)) {
      const intent = scanIntent(segment)
      if (intent === undefined || intent.bounded) continue
      const sessionDirectory = exec.agent === undefined
        ? undefined
        : ctx.get('workingDirectory')?.get(exec.agent.session)
      const workdir = resolveWorkdir((exec.arguments as { workdir?: unknown }).workdir, sessionDirectory)
      const candidates = intent.roots.length === 0
        ? [workdir]
        : intent.roots.map(root => (isAbsolute(root) ? root : resolve(workdir, root))).filter(existingDirectory)
      const blocked: HeavyRoot[] = []
      for (const root of candidates) {
        const heavy = heavyUnder(root, heavyDirectories).filter(name => !intent.excluded.includes(name))
        if (heavy.length > 0) blocked.push({ root, heavy })
      }
      if (blocked.length === 0) continue
      return denialReason(segment.text, intent, blocked)
    }
    return undefined
  })
}
