/**
 * Policy and composition coverage for @deepseek-ai/dsh-unbounded-scan-guard:
 * the command grammar (quoting, segments, one scan inside a compound command),
 * each inspected tool's bound and exclusion facts, the model-facing denial
 * through a real tool registry, and the Loader path that ships it.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ScanGuard from '@deepseek-ai/dsh-unbounded-scan-guard'
import { denialReason, resolveWorkdir, scanIntent, splitSegments } from '@deepseek-ai/dsh-unbounded-scan-guard'
import type { Config } from '@deepseek-ai/dsh-unbounded-scan-guard'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const testToolSignal = new AbortController().signal
let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A temporary scan root holding the named heavy directories. */
async function scanRoot(names: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-scan-guard-'))
  for (const name of names) await mkdir(join(directory, name), { recursive: true })
  return directory
}

/** Registry + protocol plugin + a stub `bash` that records what it was asked to run. */
async function harness(config: Config = {}): Promise<{ ran: unknown[] }> {
  const ran: unknown[] = []
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(ScanGuard, config)
  context.tools.register(defineContentToolFixture({
    name: 'bash',
    description: 'stub bash',
    parameters: {},
    execute(args) {
      ran.push(args)
      return Promise.resolve([{ type: 'text' as const, text: 'ran' }])
    },
  }))
  ctx = context
  return { ran }
}

/** One `bash` call through the registry; `workdir` is explicit so no session is needed. */
function bash(command: string, workdir: string): Promise<ToolExecutionResult> {
  return (ctx as Context).tools.execute({
    callId: ToolCallId('c1'),
    name: 'bash',
    arguments: { command, description: 'd', workdir },
    signal: testToolSignal,
  })
}

describe('shell grammar', () => {
  it('splits top-level operators and keeps quoted operators inside one segment', () => {
    expect(splitSegments("cd /tmp && echo 'a && b' | grep -rn x .").map(s => s.words[0]?.text))
      .toEqual(['cd', 'echo', 'grep'])
    expect(splitSegments('grep -rn "a | b" .')[0]?.words.map(word => word.text)).toEqual(['grep', '-rn', 'a | b', '.'])
  })

  it('reads a scan inside a compound command, not only at its start', () => {
    const segments = splitSegments('echo x && grep -rn ci_scope --include=* .')
    expect(scanIntent(segments[1]!)).toMatchObject({ tool: 'grep', roots: ['.'] })
    // The quoted segment is the command alone: operators never ride into it.
    expect(segments[1]!.text).toBe('grep -rn ci_scope --include=* .')
    expect(splitSegments('a; b | c')[2]?.text).toBe('c')
  })

  it('classifies an explicit pattern option as the pattern, not a path', () => {
    expect(scanIntent(splitSegments('grep -rn -e foo -- src')[0]!)).toMatchObject({ tool: 'grep', roots: ['src'] })
    expect(scanIntent(splitSegments('grep -rn foo src')[0]!)).toMatchObject({ tool: 'grep', roots: ['src'] })
  })

  it('reports each inspected tool with its own bound', () => {
    expect(scanIntent(splitSegments('grep -rn x .')[0]!)).toMatchObject({ tool: 'grep', bounded: false })
    expect(scanIntent(splitSegments('grep -rn x . --exclude-dir=node_modules')[0]!)).toMatchObject({ excluded: ['node_modules'] })
    expect(scanIntent(splitSegments('find . -name "*.ts"')[0]!)).toMatchObject({ tool: 'find', bounded: false })
    expect(scanIntent(splitSegments('find . -maxdepth 2 -name "*.ts"')[0]!)).toMatchObject({ bounded: true })
    expect(scanIntent(splitSegments('du -sh .')[0]!)).toMatchObject({ tool: 'du', bounded: false })
    expect(scanIntent(splitSegments('du -d 2 .')[0]!)).toMatchObject({ bounded: true })
    expect(scanIntent(splitSegments('rg -n x .')[0]!)).toMatchObject({ tool: 'rg', bounded: true })
    expect(scanIntent(splitSegments('rg -uu -n x .')[0]!)).toMatchObject({ tool: 'rg', bounded: false })
    expect(scanIntent(splitSegments('sed -n 1,2p file')[0]!)).toBeUndefined()
  })

  it('names the blocking directories and the narrowed command in the denial', () => {
    const segments = splitSegments('grep -rn x .')
    const reason = denialReason('grep -rn x .', scanIntent(segments[0]!)!, [{ root: '/w', heavy: ['node_modules'] }])
    expect(reason).toContain('grep -rn x .')
    expect(reason).toContain('/w')
    expect(reason).toContain('node_modules/')
    expect(reason).toContain('--exclude-dir=node_modules')
    expect(reason).toContain('grep tool')
  })
})

describe('scan spelling and root resolution', () => {
  it('handles escapes, newline segments, and segments with no command word', () => {
    expect(splitSegments('grep -rn x\\ y .')[0]?.words.map(word => word.text)).toEqual(['grep', '-rn', 'x y', '.'])
    expect(splitSegments('echo a\ngrep -rn x .').map(segment => segment.words[0]?.text)).toEqual(['echo', 'grep'])
    expect(splitSegments('   ;;  ')).toEqual([])
    expect(scanIntent(splitSegments('FOO=1 BAR=2')[0]!)).toBeUndefined()
    expect(scanIntent(splitSegments('sudo')[0]!)).toBeUndefined()
  })

  it('reads every recursion, bounding, and exclusion spelling', () => {
    expect(scanIntent(splitSegments('grep --dereference-recursive x .')[0]!)?.bounded).toBe(false)
    expect(scanIntent(splitSegments('grep -d recurse x .')[0]!)?.bounded).toBe(false)
    expect(scanIntent(splitSegments('grep -d skip x .')[0]!)?.bounded).toBe(true)
    expect(scanIntent(splitSegments('grep -rn x . --exclude-dir node_modules')[0]!)?.excluded).toEqual(['node_modules'])
    expect(scanIntent(splitSegments('grep -rn x . --exclude-dir=')[0]!)?.excluded).toEqual([])
    expect(scanIntent(splitSegments('find . -name node_modules -prune')[0]!)?.bounded).toBe(true)
    expect(scanIntent(splitSegments('du --max-depth 1 .')[0]!)?.bounded).toBe(true)
    expect(scanIntent(splitSegments('grep -rn x . --exclude-dir')[0]!)?.excluded).toEqual([])
    expect(scanIntent(splitSegments('rg --no-ignore x .')[0]!)?.bounded).toBe(false)
  })

  it('keeps an escaped space in a word and a trailing backslash out of the way', () => {
    expect(splitSegments('a \\ b').map(segment => segment.words.map(word => word.text))).toEqual([['a', ' b']])
    expect(splitSegments('a x\\')[0]?.words.map(word => word.text)).toEqual(['a', 'x\\'])
  })

  it('resolves an explicit, a relative, and an absent workdir against their bases', () => {
    expect(resolveWorkdir('/abs/root', '/session')).toBe('/abs/root')
    expect(resolveWorkdir('sub', '/session')).toBe('/session/sub')
    expect(resolveWorkdir('sub', undefined)).toBe(join(process.cwd(), 'sub'))
    expect(resolveWorkdir(undefined, '/session')).toBe('/session')
    expect(resolveWorkdir('', '/session')).toBe('/session')
    expect(resolveWorkdir(42, undefined)).toBe(process.cwd())
  })

  it('reads the session directory for a call that names no workdir', async () => {
    const directory = await scanRoot(['node_modules'])
    const context = new Context()
    ctx = context
    await mountAgentLoopTestDependencies(context)
    await context.plugin(AgentLoop, { agents: [] })
    context.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    context.provide('workingDirectory', { get: () => directory } as never)
    await context.plugin(ScanGuard)
    const seen: unknown[] = []
    context.tools.register(defineContentToolFixture({
      name: 'bash', description: 'stub bash', parameters: {},
      execute(args) { seen.push(args); return Promise.resolve([{ type: 'text' as const, text: 'ran' }]) },
    }))
    const agent = await context.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    // No path operand: the scan root is the session directory the stub reports.
    const result = await context.tools.execute({
      callId: ToolCallId('c1'), name: 'bash', arguments: { command: 'grep -rn x', description: 'd' }, signal: testToolSignal, agent,
    })
    expect(result.isError).toBe(true)
    expect(seen).toHaveLength(0)
  })
})

describe('policy decisions through the registry', () => {
  it('denies a tree-wide scan of a directory holding heavy trees', async () => {
    const directory = await scanRoot(['node_modules', 'target'])
    const { ran } = await harness()
    const result = await bash('grep -rn ci_scope --include=* .', directory)
    expect(result.isError).toBe(true)
    expect(ran).toHaveLength(0)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '')
      .toContain('Blocked a tree-wide scan')
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('node_modules/')
  })

  it('denies the same scan when it follows other commands in one compound call', async () => {
    const directory = await scanRoot(['target'])
    const { ran } = await harness()
    const result = await bash(`cd ${directory} && echo "=== who ===" && grep -rn 'ci_scope' --include='*' .`, directory)
    expect(result.isError).toBe(true)
    expect(ran).toHaveLength(0)
  })

  it('allows the scan once every heavy directory is excluded', async () => {
    const directory = await scanRoot(['node_modules', 'target'])
    const { ran } = await harness()
    const result = await bash('grep -rn x . --exclude-dir=node_modules --exclude-dir=target', directory)
    expect(result.isError).toBe(false)
    expect(ran).toHaveLength(1)
  })

  it('resolves an absolute scan root named by the command', async () => {
    const directory = await scanRoot(['node_modules'])
    const elsewhere = await scanRoot([])
    const { ran } = await harness()
    const result = await bash(`grep -rn x ${directory}`, elsewhere)
    expect(result.isError).toBe(true)
    expect(ran).toHaveLength(0)
  })

  it('allows a scan scoped to a subtree without heavy directories', async () => {
    const directory = await scanRoot(['node_modules'])
    await mkdir(join(directory, 'src'), { recursive: true })
    const { ran } = await harness()
    expect((await bash('grep -rn x ./src', directory)).isError).toBe(false)
    expect(ran).toHaveLength(1)
  })

  it('allows scans the inspected tools already bound', async () => {
    const directory = await scanRoot(['node_modules'])
    const { ran } = await harness()
    expect((await bash('grep -n x file.txt', directory)).isError).toBe(false)
    expect((await bash('find . -maxdepth 1 -name x', directory)).isError).toBe(false)
    expect((await bash('du -d 1 .', directory)).isError).toBe(false)
    expect((await bash('rg -n x .', directory)).isError).toBe(false)
    expect(ran).toHaveLength(4)
  })

  it('denies find, du, and ripgrep-without-ignore over a heavy tree', async () => {
    const directory = await scanRoot(['.git'])
    await harness()
    expect((await bash('find . -name "*.ts"', directory)).isError).toBe(true)
    expect((await bash('du -sh .', directory)).isError).toBe(true)
    expect((await bash('rg -uu pattern .', directory)).isError).toBe(true)
  })

  it('leaves other tools, other commands, and calls without a command alone', async () => {
    const directory = await scanRoot(['node_modules'])
    const context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(ScanGuard)
    const seen: string[] = []
    context.tools.register(defineContentToolFixture({
      name: 'other', description: 'o', parameters: {},
      execute() { seen.push('other'); return Promise.resolve([{ type: 'text' as const, text: 'ok' }]) },
    }))
    context.tools.register(defineContentToolFixture({
      name: 'bash', description: 'stub bash', parameters: {},
      execute() { seen.push('bash'); return Promise.resolve([{ type: 'text' as const, text: 'ran' }]) },
    }))
    ctx = context
    expect((await context.tools.execute({
      callId: ToolCallId('c1'), name: 'other', arguments: { command: 'grep -rn x .', workdir: directory }, signal: testToolSignal,
    })).isError).toBe(false)
    expect((await bash('ls -la', directory)).isError).toBe(false)
    const commandless = await context.tools.execute({
      callId: ToolCallId('c2'), name: 'bash', arguments: {}, signal: testToolSignal,
    })
    expect(commandless.isError).toBe(false)
    expect(seen).toEqual(['other', 'bash', 'bash'])
  })

  it('honors the configured heavy-directory list and tool set', async () => {
    const directory = await scanRoot(['node_modules'])
    const { ran } = await harness({ heavyDirectories: ['build'] })
    // `node_modules` is not in the configured list: the same scan is allowed.
    expect((await bash('grep -rn x .', directory)).isError).toBe(false)
    expect(ran).toHaveLength(1)
    const withBuild = await scanRoot(['build'])
    await harness({ heavyDirectories: ['build'] })
    expect((await bash('grep -rn x .', withBuild)).isError).toBe(true)
    const other = await harness({ tools: ['other-shell'] })
    expect((await bash('grep -rn x .', withBuild)).isError).toBe(false)
    expect(other.ran).toHaveLength(1)
  })

  it('fails loud on an unusable configuration', async () => {
    const context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    const badDirectory = await context.plugin(ScanGuard, { heavyDirectories: ['a/b'] }).then(() => undefined, (error: unknown) => error)
    expect(String(badDirectory)).toMatch(/heavyDirectories/)
    ctx = context
    const second = new Context()
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    const badTools = await second.plugin(ScanGuard, { tools: [] }).then(() => undefined, (error: unknown) => error)
    expect(String(badTools)).toMatch(/tools/)
    await second.fiber.dispose()
  })
})

describe('unbounded-scan-guard real Loader composition', () => {
  it('loads the plugin and applies its policy through the registry', async () => {
    const directory = await scanRoot(['node_modules'])
    root = await mkdtemp(join(tmpdir(), 'dsh-scan-guard-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: 'cordis:@deepseek-ai/dsh-system-prompt'",
      "- name: 'cordis:@deepseek-ai/dsh-tools'",
      "- name: 'cordis:@deepseek-ai/dsh-unbounded-scan-guard'",
      '  config:',
      '    heavyDirectories: [node_modules]',
      '',
    ].join('\n'))

    const context = new Context()
    ctx = context
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.builtins['@deepseek-ai/dsh-system-prompt'] = SystemPrompt
    context.loader.builtins['@deepseek-ai/dsh-tools'] = ToolRuntime
    context.loader.builtins['@deepseek-ai/dsh-unbounded-scan-guard'] = ScanGuard
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    context.tools.register(defineContentToolFixture({
      name: 'bash', description: 'stub', parameters: {},
      execute() { return Promise.resolve([{ type: 'text' as const, text: 'ran' }]) },
    }))
    const result = await context.tools.execute({
      callId: ToolCallId('c1'),
      name: 'bash',
      arguments: { command: 'grep -rn x .', description: 'd', workdir: directory },
      signal: testToolSignal,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('Blocked a tree-wide scan')
  })

  it('exports named plugin members and no default export', async () => {
    const module = await import('@deepseek-ai/dsh-unbounded-scan-guard')
    expect('default' in module).toBe(false)
    expect(module.name).toBe('unbounded-scan-guard')
    expect(typeof module.apply).toBe('function')
  })
})
