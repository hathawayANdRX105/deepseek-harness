// @vitest-environment jsdom
/**
 * ui-goal browser half on a real cordis Context with fake slots/api/
 * sessions faces: the plugin registers the GoalBar dock entry at
 * conversation.input.dock, the inject face's four verbs read the CAS ref
 * from the session's CURRENT projected value at call time (no fence — the
 * Remote method's compare-and-set is the guard), a missing projection short-circuits
 * to the no-current-goal error without touching the wire, and a Remote failure
 * reaches the strip verbatim. Registration disposal rides the
 * plugin fiber (HMR safety), and the node half stays inert.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { GoalActivation, GoalId, GoalProjection, GoalView } from '@deepseek-ai/dsh-goal/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, RemoteError, stubConfigForm, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionFixture } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { AutoGoalToggleInjected, GoalActivationSnapshot, GoalBarActions, GoalBarInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { GoalDock } from '../src/client/GoalBar.tsx'
import { AutoGoalToggle } from '../src/client/AutoGoalToggle.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId
const GOAL_ID = 'g-1' as GoalId

/** One composer prompt as the Host records it in the inbox. */
function userMessage(text: string): UserMessage {
  return {
    id: 'm-1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

/** Give the watcher time to observe a prompt that must not create a goal. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

// The auto-goal preference persists in local storage, so every test starts from
// the same state.
beforeEach(() => {
  window.localStorage.clear()
})

/** Render the toggle with the plugin's own injected face. */
function renderToggle(injected: AutoGoalToggleInjected): void {
  const autoGoal = injected.hooks.autoGoal
  const props = {
    useAutoGoal: (selector: (value: boolean) => unknown) => selector(autoGoal.getSnapshot()),
    ...injected,
    t: makeTranslate(zh, commonZh),
  } as unknown as Parameters<typeof AutoGoalToggle>[0]
  render(<AutoGoalToggle {...props} />)
}

function makeProjection(revision = 3): GoalProjection {
  return {
    goal: {
      id: GOAL_ID,
      revision,
      objective: 'Ship it',
      phase: 'active',
      maxGoalRounds: 8,
    },
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 20,
  }
}

/** Boot the plugin over fake faces; Goal Remote methods record arguments and answer per the script. */
async function bench(options: {
  projection?: GoalProjection | null | undefined
  activation?: GoalActivation
  failWith?: RemoteFailure
  initialOpen?: SessionFixture['initialOpen']
  snapshot?: SessionFixture['snapshot']
} = {}) {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  await sessions.add({
    id: 's1',
    ...options.initialOpen === undefined ? {} : { initialOpen: options.initialOpen },
    ...options.snapshot === undefined ? {} : { snapshot: options.snapshot },
  })
  await sessions.setProjection('s1', 'goal', options.projection)
  const owner = sessions.retainFor(ctx, sid('s1'))
  ctx.provide('sessions', sessions)
  const conversationEvents = new UiConversation(ctx, sessions).events
  function answer<T>(method: string, value: T) {
    return (...args: unknown[]) => {
      calls.push({ method, args })
      if (options.failWith !== undefined) return Promise.resolve({ ok: false, error: options.failWith })
      return Promise.resolve({ ok: true, value })
    }
  }
  const ref = { id: 'g-1', revision: 3 }
  const goalView = (): GoalView | undefined => {
    if (options.projection === null || options.projection === undefined) return undefined
    return {
      ...options.projection.goal,
      roundsStarted: options.projection.roundsStarted,
      createdAt: options.projection.createdAt,
      updatedAt: options.projection.updatedAt,
      activation: options.activation ?? 'armed',
    }
  }
  const goals = (prefix: string) => ({
    get: answer(`${prefix}/get`, goalView()),
    edit: answer(`${prefix}/edit`, { ref }),
    pause: answer(`${prefix}/pause`, { ref }),
    resume: answer(`${prefix}/resume`, { ref }),
    clear: answer(`${prefix}/clear`, ref),
    create: answer(`${prefix}/create`, { ref }),
  })
  let activeGoals: ReturnType<typeof goals> | undefined = goals('goals')
  class RemoteService extends Service {
    readonly activationListeners = new Set<(event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void>()

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $on(_event: string, listener: (event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void): () => void {
      this.activationListeners.add(listener)
      return () => { this.activationListeners.delete(listener) }
    }

    emitActivation(
      sessionId: SessionId,
      goal: { id: string; revision: number; activation: GoalActivation } | undefined,
    ): void {
      for (const listener of this.activationListeners) {
        listener({ sessionId, ...goal === undefined ? {} : { goal } })
      }
    }
  }
  const remote = new RemoteService(ctx)
  ctx.provide('remote.goals', {
    get get() { return activeGoals?.get },
    get edit() { return activeGoals?.edit },
    get pause() { return activeGoals?.pause },
    get resume() { return activeGoals?.resume },
    get clear() { return activeGoals?.clear },
    get create() { return activeGoals?.create },
  })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const goalSettings = stubConfigForm<{ autoGoal: boolean }>()
  ctx.provide('configForms', { get: () => goalSettings.scope } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    sessions,
    owner,
    goalSettings,
    emitActivation: remote.emitActivation.bind(remote),
    definitions: () => conversationEvents.entries(),
    remountGoals: () => { activeGoals = goals('remounted-goals') },
    unmountGoals: () => { activeGoals = undefined },
    entry: () => {
      const entry = ctx.slots.entries('conversation.input.dock').find(entry => entry.options.id === 'goal')
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => GoalBarInjected) | undefined,
      }
    },
    autoGoalEntry: () => ctx.slots.entries('conversation.input.dock').find(entry => entry.options.id === 'goal-auto'),
    autoGoalInject: () => {
      const entry = ctx.slots.entries('conversation.input.dock').find(entry => entry.options.id === 'goal-auto')
      const inject = entry?.inject as unknown as ((sessionId: SessionId) => AutoGoalToggleInjected) | undefined
      if (inject === undefined) throw new Error('ui-goal: the auto-goal dock entry is not registered')
      return inject(sid('s1'))
    },
    chatEntry: () => ctx.slots.entries('conversation.chat.node')[0],
    splicePrompt: (messages: UserMessage[], seq = 1) => sessions.appendEvent('s1', {
      type: 'event',
      event: {
        type: 'agent/inbox/spliced',
        seq: seq as SessionSeq,
        time: seq,
        data: { target: 'next-turn', start: 0, inserted: messages },
      },
    }),
  }
}

describe('ui-goal browser plugin', () => {
  it('waits for initial history before reading activation and releases the read reference', async () => {
    const opened = Promise.withResolvers<undefined>()
    const b = await bench({ projection: makeProjection(), activation: 'disarmed', initialOpen: () => opened.promise })
    await b.fiber.await()
    const source = b.entry()!.inject!(sid('s1')).hooks.goalActivation
    const dispose = source.subscribe(() => {})
    try {
      expect(b.calls).toEqual([])
      expect(b.sessions.retainInfo(sid('s1')).getSnapshot().retainedBy.goalActivation).toBe(1)
      opened.resolve(undefined)
      await waitFor(() => { expect(source.getSnapshot().activation).toBe('disarmed') })
      expect(b.calls).toEqual([{ method: 'goals/get', args: [sid('s1')] }])
      expect(b.sessions.retainInfo(sid('s1')).getSnapshot().referenceCount).toBe(1)
    } finally {
      opened.resolve(undefined)
      dispose()
    }
  })

  it.each([true, false])('keeps projected goal state after an unsuccessful history open (reported error: %s)', async (reported) => {
    const error = new RemoteError('gateway/internal', 'history unavailable', {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const b = await bench({ projection: makeProjection(), snapshot: { openState: 'error', openError: reported ? error : null } })
    await b.fiber.await()
    const source = b.entry()!.inject!(sid('s1')).hooks.goalActivation
    const dispose = source.subscribe(() => {})
    try {
      await waitFor(() => { expect(warn).toHaveBeenCalledOnce() })
      expect(warn).toHaveBeenCalledWith('[ui-goal] goal activation read failed:', expect.objectContaining({
        message: reported ? 'history unavailable' : 'session "s1" is not open',
      }))
      expect(source.getSnapshot()).toEqual({ id: GOAL_ID, revision: 3 })
      expect(b.calls).toEqual([])
      expect(b.sessions.retainInfo(sid('s1')).getSnapshot().referenceCount).toBe(1)
    } finally {
      dispose()
    }
  })

  it('refuses activation reads captured from a replaced Session binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const source = b.entry()!.inject!(sid('s1')).hooks.goalActivation
    b.owner.release()
    b.sessions.retainFor(b.ctx, sid('s1'))
    const dispose = source.subscribe(() => {})
    try {
      await waitFor(() => { expect(warn).toHaveBeenCalledWith('[ui-goal] goal activation read failed:', expect.objectContaining({
        message: 'ui-goal: session "s1" is unavailable',
      })) })
      expect(b.calls).toEqual([])
    } finally {
      dispose()
    }
  })

  it('registers the GoalBar and auto-goal docks, command input Definition, and keyed Chat renderer', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toMatchObject({ id: 'goal', order: 10, locale: 'goal' })
    expect(b.entry()?.inject).toBeTypeOf('function')
    expect(() => b.entry()!.inject!(sid('missing'))).toThrow(/unavailable/)
    expect(b.autoGoalEntry()?.options).toMatchObject({ id: 'goal-auto', order: -10 })
    expect(b.autoGoalEntry()?.locale).toBe('goal')
    expect(b.autoGoalEntry()?.inject).toBeTypeOf('function')
    expect(b.definitions().map(definition => definition.kind)).toEqual(['goal-command-input'])
    expect(b.chatEntry()?.options).toMatchObject({ key: 'command-input' })
    expect(b.chatEntry()?.locale).toBe('goal')
  })

  it('keeps the preference in local storage and mirrors it into the Host form', async () => {
    const b = await bench()
    await b.fiber.await()
    const autoGoalInject = b.autoGoalEntry()!.inject as unknown as ((sessionId: SessionId) => AutoGoalToggleInjected)
    const injected = autoGoalInject(sid('s1'))
    expect(injected.hooks.autoGoal.getSnapshot()).toBe(false)
    injected.setAutoGoal(true)
    expect(injected.hooks.autoGoal.getSnapshot()).toBe(true)
    expect(b.goalSettings.set).toHaveBeenCalledWith('autoGoal', true)
    expect(window.localStorage.getItem('dsh.ui-goal.autoGoal')).toBe('true')
    injected.setAutoGoal(false)
    expect(b.goalSettings.set).toHaveBeenLastCalledWith('autoGoal', false)
    expect(window.localStorage.getItem('dsh.ui-goal.autoGoal')).toBe('false')
  })

  it('restores the preference from local storage on the next load', async () => {
    window.localStorage.setItem('dsh.ui-goal.autoGoal', 'true')
    const b = await bench()
    await b.fiber.await()
    const autoGoalInject = b.autoGoalEntry()!.inject as unknown as ((sessionId: SessionId) => AutoGoalToggleInjected)
    expect(autoGoalInject(sid('s1')).hooks.autoGoal.getSnapshot()).toBe(true)
  })

  it('creates the session goal from a composer prompt while the preference is armed', async () => {
    const b = await bench()
    await b.fiber.await()
    const injected = b.autoGoalInject()
    renderToggle(injected)
    injected.setAutoGoal(true)
    await b.splicePrompt([userMessage('ship the release notes')])
    await waitFor(() => {
      expect(b.calls.some(call => call.method === 'goals/create')).toBe(true)
    })
    const create = b.calls.find(call => call.method === 'goals/create')
    expect(create?.args[0]).toBe('s1')
    expect(create?.args[1]).toEqual({ objective: 'ship the release notes' })
  })

  it('clears a goal that is not complete before creating the new one', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const injected = b.autoGoalInject()
    renderToggle(injected)
    injected.setAutoGoal(true)
    await b.splicePrompt([userMessage('second task')])
    await waitFor(() => {
      expect(b.calls.some(call => call.method === 'goals/clear')).toBe(true)
    })
    const clear = b.calls.find(call => call.method === 'goals/clear')
    expect(clear?.args[1]).toEqual({ id: 'g-1', revision: 3 })
  })

  it('creates no goal for a prompt while the preference is off', async () => {
    const b = await bench()
    await b.fiber.await()
    renderToggle(b.autoGoalInject())
    await b.splicePrompt([userMessage('no goal wanted')])
    await settle()
    expect(b.calls.some(call => call.method === 'goals/create')).toBe(false)
  })

  it('creates no goal for a message that is not a composer prompt', async () => {
    const b = await bench()
    await b.fiber.await()
    const injected = b.autoGoalInject()
    renderToggle(injected)
    injected.setAutoGoal(true)
    await b.splicePrompt([{ ...userMessage('round input'), source: { kind: 'goal' } } as unknown as UserMessage])
    await settle()
    expect(b.calls.some(call => call.method === 'goals/create')).toBe(false)
  })

  it('creates no goal for a prompt without text', async () => {
    const b = await bench()
    await b.fiber.await()
    const injected = b.autoGoalInject()
    renderToggle(injected)
    injected.setAutoGoal(true)
    await b.splicePrompt([userMessage('   ')])
    await settle()
    expect(b.calls.some(call => call.method === 'goals/create')).toBe(false)
  })

  it('verbs read the CAS ref from the current projected value at call time', async () => {
    const b = await bench({ projection: makeProjection(5) })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    // The strip forwards the Remote value verbatim; `answered` is the fake's
    // reply, unrelated to the CAS ref the call carries.
    const answered = { id: 'g-1', revision: 3 }
    expect(await verbs.onEdit('New objective')).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onResume()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onClear()).toEqual({ ok: true, value: answered })
    expect(b.calls.map(c => c.method)).toEqual(['goals/edit', 'goals/pause', 'goals/resume', 'goals/clear'])
    const ref = { id: 'g-1', revision: 5 }
    expect(b.calls[0]?.args).toEqual(['s1', ref, { objective: 'New objective' }])
    expect(b.calls[1]?.args).toEqual(['s1', ref])
    expect(b.calls[2]?.args).toEqual(['s1', ref])
    expect(b.calls[3]?.args).toEqual(['s1', ref])
  })

  it('verbs read a remounted Remote namespace at action time', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.remountGoals()

    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: { id: 'g-1', revision: 3 } } })
    expect(b.calls).toMatchObject([{ method: 'remounted-goals/pause' }])
  })

  it('binds the activation hook and forwards only this session activation events', async () => {
    const b = await bench({ projection: makeProjection(), activation: 'disarmed' })
    await b.fiber.await()
    const injected = b.entry()!.inject!(sid('s1'))
    const source = injected.hooks.goalActivation
    const seen: unknown[] = []
    const dispose = source.subscribe(() => { seen.push(source.getSnapshot()) })
    await waitFor(() => {
      expect(source.getSnapshot()).toMatchObject({ id: 'g-1', revision: 3, activation: 'disarmed' })
    })
    expect(b.calls.at(-1)).toMatchObject({ method: 'goals/get', args: ['s1'] })

    b.emitActivation(sid('s2'), { id: 'g-1', revision: 3, activation: 'armed' })
    expect(source.getSnapshot().activation).toBe('disarmed')
    b.emitActivation(sid('s1'), { id: 'g-1', revision: 3, activation: 'armed' })
    expect(source.getSnapshot().activation).toBe('armed')
    dispose()
    expect(seen.length).toBeGreaterThan(0)
  })

  it('rejects every verb once the Remote namespace is gone', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.unmountGoals()

    // A missing namespace is an assembly fault, not a call outcome: this plugin
    // declares remote.goals in `inject`, so cordis disposes the dock entry along
    // with the namespace. Only a React closure that outlived that disposal can
    // reach these verbs, so no consumer-side guard renders it as an error.
    for (const verb of [() => verbs.onEdit('x'), () => verbs.onPause(), () => verbs.onResume(), () => verbs.onClear()]) {
      await expect(verb()).rejects.toThrow(TypeError)
    }
    expect(b.calls).toHaveLength(0)
  })

  it('a null or absent projection short-circuits every verb without touching the wire', async () => {
    for (const projection of [null, undefined]) {
      const b = await bench({ projection })
      await b.fiber.await()
      const verbs = b.entry()!.inject!(sid('s1'))
      for (const result of [await verbs.onEdit('x'), await verbs.onPause(), await verbs.onResume(), await verbs.onClear()]) {
        expect(result).toEqual({ ok: false, error: { code: 'no-current-goal', message: 'no current goal to mutate' } })
      }
      expect(b.calls).toHaveLength(0)
    }
  })

  it('forwards a Remote failure to the strip verbatim', async () => {
    const b = await bench({
      projection: makeProjection(),
      failWith: new RemoteError('gateway/internal', 'stale revision', {}),
    })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    expect(await verbs.onEdit('x')).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'stale revision' } })
  })

  it('drops the dock entry when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    expect(b.chatEntry()).toBeDefined()
    expect(b.definitions()).toHaveLength(1)
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.chatEntry()).toBeUndefined()
    expect(b.definitions()).toHaveLength(0)
  })
})

describe('GoalDock adapter', () => {
  it('renders the projected goal snapshot and nothing for absent/null', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const useGoalActivation = (
      selector: (snapshot: GoalActivationSnapshot) => unknown,
    ) => selector({ id: GOAL_ID, revision: 3, activation: 'armed' })
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const t = makeTranslate(zh, commonZh)
    const dockProps = (up: () => GoalProjection | null | undefined) =>
      ({ useProjection: up, useGoalActivation, ...actions, t }) as unknown as Parameters<typeof GoalDock>[0]
    const shown = render(<GoalDock {...dockProps(useProjection)} />)
    expect(shown.getByText('Ship it')).toBeTruthy()
    cleanup()

    const empty = render(<GoalDock {...dockProps(() => null)} />)
    expect(empty.container.firstChild).toBeNull()
    cleanup()

    const absent = render(<GoalDock {...dockProps(() => undefined)} />)
    expect(absent.container.firstChild).toBeNull()
  })

  it('matches activation by goal id and revision from the injected hook', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const useGoalActivation = (
      selector: (snapshot: GoalActivationSnapshot) => unknown,
    ) => selector({ id: GOAL_ID, revision: 3, activation: 'disarmed' })
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const t = makeTranslate(zh, commonZh)
    const props = { useProjection, useGoalActivation, ...actions, t } as unknown as Parameters<typeof GoalDock>[0]
    const rendered = render(<GoalDock {...props} />)
    expect(rendered.getByText('已暂停的目标')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy()
    expect(rendered.queryByRole('button', { name: '暂停目标' })).toBeNull()
  })
})

describe('AutoGoalToggle', () => {
  it('renders the preference state as a button and toggles it', () => {
    const autoGoal = createSnapshotStore(false)
    const setAutoGoal = vi.fn((enabled: boolean) => { autoGoal.set(enabled) })
    const t = makeTranslate(zh, commonZh)
    const props = {
      useAutoGoal: (selector: (value: boolean) => unknown) => selector(autoGoal.getSnapshot()),
      setAutoGoal,
      subscribePrompts: () => () => {},
      armGoal: () => {},
      t,
    } as unknown as Parameters<typeof AutoGoalToggle>[0]
    const rendered = render(<AutoGoalToggle {...props} />)
    expect(rendered.getByText('goal')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: '开启自动目标模式' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(setAutoGoal).toHaveBeenCalledWith(true)
    expect(autoGoal.getSnapshot()).toBe(true)
  })

  it('marks the enabled state with a pressed button', () => {
    const autoGoal = createSnapshotStore(true)
    const setAutoGoal = vi.fn((enabled: boolean) => { autoGoal.set(enabled) })
    const t = makeTranslate(zh, commonZh)
    const props = {
      useAutoGoal: (selector: (value: boolean) => unknown) => selector(autoGoal.getSnapshot()),
      setAutoGoal,
      subscribePrompts: () => () => {},
      armGoal: () => {},
      t,
    } as unknown as Parameters<typeof AutoGoalToggle>[0]
    render(<AutoGoalToggle {...props} />)
    const toggle = screen.getByRole('button', { name: '关闭自动目标模式' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(setAutoGoal).toHaveBeenCalledWith(false)
  })
})
