// Opt-in browser diagnostic for switching cost: sidebar switches between long
// Sessions and in-Session Chat/Trajectory toggles on one long Session. It
// reports measurements without timing assertions because host speed is not a
// correctness contract; structural assertions keep the workload from silently
// shrinking. Every sample separates wall time from Chromium main-thread task
// time, so a slow host round trip is distinguishable from slow rendering.
import { performance } from 'node:perf_hooks'
import type { Browser, CDPSession, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  type WebScaffold,
  type WebConsoleTripwire,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

/** Settled-Turn witness: one mounted tail footer per turn inside the loaded window. */
const TAIL = '[data-chat-flow-key^="9:turn-tail"]'
const LONG_TURNS = 200
const SMALL_SESSIONS = 8
const UI_TIMEOUT_MS = 30_000

interface SwitchSession {
  readonly id: string
  readonly title: string
  readonly markerPrefix: string
  /** Assistant marker of the last turn; the first open lands on the tail window. */
  readonly tailMarker: string
}

const ALPHA: SwitchSession = {
  id: 'switch-alpha',
  title: 'SWITCH_ALPHA',
  markerPrefix: 'alpha',
  tailMarker: 'CHAT_SCROLL_alpha_ASSISTANT_200',
}
const BRAVO: SwitchSession = {
  id: 'switch-bravo',
  title: 'SWITCH_BRAVO',
  markerPrefix: 'bravo',
  tailMarker: 'CHAT_SCROLL_bravo_ASSISTANT_200',
}
const CHARLIE: SwitchSession = {
  id: 'switch-charlie',
  title: 'SWITCH_CHARLIE',
  markerPrefix: 'charlie',
  tailMarker: 'CHAT_SCROLL_charlie_ASSISTANT_200',
}

interface ChromiumMetrics {
  readonly [name: string]: number
}

interface Sample {
  readonly label: string
  readonly wallMs: number
  /** Chromium main-thread task time inside the interval; excludes host/RPC waiting. */
  readonly taskMs: number
  readonly scriptMs: number
  readonly layoutMs: number
  readonly recalcStyleMs: number
  readonly nodesDelta: number
  readonly listenersDelta: number
  readonly totalNodes: number
  readonly heapMb: number
  /** Gesture to first committed transcript content of the incoming target. */
  readonly firstContentMs: number | null
  /** First committed content to the completion witness, including two frames. */
  readonly settleMs: number | null
}

interface SwitchProbe {
  readonly clickAt: number | null
  readonly firstContentAt: number | null
  readonly doneAt: number | null
}

/**
 * Install the phase probe before a measured gesture. A probe that only looked
 * for any mounted Assistant step would observe the outgoing Session, so the
 * observer waits for the incoming target's own tail marker.
 * @param page - measured page.
 * @param marker - tail Assistant marker of the incoming Session.
 */
async function installSwitchProbe(page: Page, marker: string): Promise<void> {
  await page.evaluate((marker) => {
    const record = { clickAt: null as number | null, firstContentAt: null as number | null, doneAt: null as number | null }
    Reflect.set(globalThis, '__dshSwitchProbe', record)
    document.addEventListener('click', (event) => {
      if (event.isTrusted) record.clickAt = globalThis.performance.now()
    }, { capture: true, once: true })
    const observer = new MutationObserver(() => {
      if (record.firstContentAt !== null) return
      const step = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)
      if (step !== undefined && (step.textContent ?? '').includes(marker)) {
        record.firstContentAt = globalThis.performance.now()
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }, marker)
}

async function readSwitchProbe(page: Page): Promise<SwitchProbe> {
  return page.evaluate(() => Reflect.get(globalThis, '__dshSwitchProbe') as SwitchProbe)
}

async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { resolve() })
    })
  }))
}

async function chromiumMetrics(cdp: CDPSession): Promise<ChromiumMetrics> {
  const payload = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(payload.metrics.map(metric => [metric.name, metric.value]))
}

function metric(metrics: ChromiumMetrics, name: string): number {
  const value = metrics[name]
  if (value === undefined) throw new Error(`Chromium performance metric ${name} is unavailable`)
  return value
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

/**
 * Time one UI action from the caller's gesture to the target DOM state plus
 * two animation frames, with the Chromium metric deltas of the same interval.
 * @param page - measured page.
 * @param cdp - enabled Performance domain session on that page.
 * @param label - report identity for this sample.
 * @param action - the gesture and its completion witness.
 * @returns the sample.
 */
async function measure(
  page: Page,
  cdp: CDPSession,
  label: string,
  action: () => Promise<void>,
  probeMarker?: string,
): Promise<Sample> {
  if (probeMarker !== undefined) await installSwitchProbe(page, probeMarker)
  const before = await chromiumMetrics(cdp)
  const started = performance.now()
  await action()
  await painted(page)
  const wallMs = performance.now() - started
  const doneAt = await page.evaluate(() => globalThis.performance.now())
  const after = await chromiumMetrics(cdp)
  const probe = probeMarker === undefined ? undefined : await readSwitchProbe(page)
  return {
    label,
    wallMs: rounded(wallMs),
    taskMs: rounded((metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1_000),
    scriptMs: rounded((metric(after, 'ScriptDuration') - metric(before, 'ScriptDuration')) * 1_000),
    layoutMs: rounded((metric(after, 'LayoutDuration') - metric(before, 'LayoutDuration')) * 1_000),
    recalcStyleMs: rounded(
      (metric(after, 'RecalcStyleDuration') - metric(before, 'RecalcStyleDuration')) * 1_000,
    ),
    nodesDelta: metric(after, 'Nodes') - metric(before, 'Nodes'),
    listenersDelta: metric(after, 'JSEventListeners') - metric(before, 'JSEventListeners'),
    totalNodes: metric(after, 'Nodes'),
    heapMb: rounded(metric(after, 'JSHeapUsedSize') / 1_048_576),
    firstContentMs: probe?.clickAt === null || probe?.clickAt === undefined || probe.firstContentAt === null
      ? null
      : rounded(probe.firstContentAt - probe.clickAt),
    settleMs: probe?.firstContentAt === null || probe?.firstContentAt === undefined
      ? null
      : rounded(doneAt - probe.firstContentAt),
  }
}

/** Row of one seeded Session in the expanded sidebar tree. */
function sessionRow(page: Page, session: SwitchSession) {
  return page.locator(`[data-row-key="session:${session.id}"]`)
}

/**
 * Wait until the bound Session's tail Turn carries its marker in the last
 * Assistant step. The probe reads one node, not the whole loaded history:
 * whole-history text scans would inject observer cost into the interval.
 * @param page - measured page.
 * @param sessionId - expected `data-conversation-session` value.
 * @param marker - tail Assistant marker of that Session.
 */
async function waitTranscript(page: Page, sessionId: string, marker: string): Promise<void> {
  await page.waitForFunction(({ sessionId, marker }) => {
    const bound = document.querySelector(`[data-conversation-content][data-conversation-session="${sessionId}"]`)
    if (bound === null) return false
    const step = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)
    return step !== undefined && (step.textContent ?? '').includes(marker)
  }, { sessionId, marker }, { timeout: UI_TIMEOUT_MS })
}

/** Wait for the Trajectory view's own readiness witness. */
async function waitTrajectory(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const search = document.querySelector('input[type="search"][aria-label="Search trajectory"]')
    if (search === null || !search.checkVisibility({ checkVisibilityCSS: true })) return false
    return Array.from(document.querySelectorAll('[data-trajectory-scroll] [data-trajectory-row-key]'))
      .some(row => row.checkVisibility({ checkVisibilityCSS: true }))
  }, undefined, { timeout: UI_TIMEOUT_MS })
}

async function openSessionRow(page: Page, session: SwitchSession): Promise<void> {
  await sessionRow(page, session).click()
  await waitTranscript(page, session.id, session.tailMarker)
}

async function clickTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click()
}

async function retainedState(page: Page, cdp: CDPSession): Promise<Record<string, number>> {
  await cdp.send('HeapProfiler.collectGarbage')
  const metrics = await chromiumMetrics(cdp)
  return {
    domElements: await page.evaluate(() => document.querySelectorAll('*').length),
    nodes: metric(metrics, 'Nodes'),
    listeners: metric(metrics, 'JSEventListeners'),
    heapMb: rounded(metric(metrics, 'JSHeapUsedSize') / 1_048_576),
  }
}

describe('session switching cost', () => {
  let browser: Browser | undefined
  let scaffold: WebScaffold | undefined
  let page: Page | undefined
  let tripwire: WebConsoleTripwire | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const long = (session: SwitchSession) => createChatScrollFixture({
      markerPrefix: session.markerPrefix,
      title: session.title,
      turns: LONG_TURNS,
    }).log
    for (const session of [ALPHA, BRAVO, CHARLIE]) {
      await seedSession(scaffold, long(session), session.id)
    }
    for (let index = 0; index < SMALL_SESSIONS; index += 1) {
      const prefix = `small${String(index).padStart(2, '0')}`
      await seedSession(
        scaffold,
        createChatScrollFixture({ markerPrefix: prefix, title: `SWITCH_${prefix.toUpperCase()}`, turns: 2 }).log,
        `switch-${prefix}`,
      )
    }
    browser = await chromium.launch({ headless: true })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.setDefaultTimeout(UI_TIMEOUT_MS)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: UI_TIMEOUT_MS })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await page?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'session-switch perf teardown failed')
  })

  it('reports sidebar Session switches and Chat/Trajectory toggles', async () => {
    const world = page!
    const server = scaffold!
    const group = world.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    // The tree shows a bounded recent slice plus explicit expanders; reveal
    // every seeded row before measuring so each switch is a trusted click.
    for (let round = 0; round < 3; round += 1) {
      const more = world.getByRole('button', { name: /Show \d+ more session/ })
      if (await more.count() === 0) break
      await more.first().click()
    }
    for (const session of [ALPHA, BRAVO, CHARLIE]) {
      await sessionRow(world, session).waitFor()
    }

    const cdp = await world.context().newCDPSession(world)
    await cdp.send('Performance.enable')
    const samples: Sample[] = []
    const record = async (label: string, action: () => Promise<void>, marker?: string): Promise<Sample> => {
      const sample = await measure(world, cdp, label, action, marker)
      samples.push(sample)
      console.info(`SESSION_SWITCH_SAMPLE ${JSON.stringify(sample)}`)
      return sample
    }

    await record('coldOpenAlpha', () => openSessionRow(world, ALPHA), ALPHA.tailMarker)
    const openedTurns = await world.locator(TAIL).count()
    expect(openedTurns).toBeGreaterThan(0)
    expect(openedTurns).toBeLessThan(LONG_TURNS)

    await record('coldSwitchAlphaToBravo', () => openSessionRow(world, BRAVO), BRAVO.tailMarker)
    await record('warmSwitchBravoToAlpha', () => openSessionRow(world, ALPHA), ALPHA.tailMarker)
    await record('warmSwitchAlphaToBravo', () => openSessionRow(world, BRAVO), BRAVO.tailMarker)
    await record('coldSwitchBravoToCharlie', () => openSessionRow(world, CHARLIE), CHARLIE.tailMarker)
    await record('warmSwitchCharlieToAlpha', () => openSessionRow(world, ALPHA), ALPHA.tailMarker)

    const afterSwitches = await retainedState(world, cdp)

    await record('alphaTabToTrajectory', async () => {
      await clickTab(world, 'Trajectory')
      await waitTrajectory(world)
    })
    await record('alphaTabToChat', async () => {
      await clickTab(world, 'Chat')
      await waitTranscript(world, ALPHA.id, ALPHA.tailMarker)
    }, ALPHA.tailMarker)
    await record('alphaTabToTrajectoryAgain', async () => {
      await clickTab(world, 'Trajectory')
      await waitTrajectory(world)
    })
    await record('alphaTabToChatAgain', async () => {
      await clickTab(world, 'Chat')
      await waitTranscript(world, ALPHA.id, ALPHA.tailMarker)
    }, ALPHA.tailMarker)
    const afterTabs = await retainedState(world, cdp)

    console.info(`WEB_PERF_RESULT ${JSON.stringify({
      scenario: 'session-switch',
      fixture: {
        longSessions: 3,
        longTurns: LONG_TURNS,
        smallSessions: SMALL_SESSIONS,
        initialWindowTurns: openedTurns,
      },
      samples,
      retained: { afterSwitches, afterTabs },
    }, null, 2)}`)

    expect(tripwire!.warnings).toEqual([])
    expect(tripwire!.pageErrors).toEqual([])
    expect(server.baseUrl).toBe(new URL(world.url()).origin)
  })

  it('reports the transcript anchor across a Trajectory detour', async () => {
    const world = page!
    const scroller = world.locator('[data-conversation-scroll]')
    // A reader gesture, then an upstream offset: following the tail would snap
    // back, and wheel marks the movement as reader-owned before the write.
    // When the main-conversation transcript fits the viewport, range is zero;
    // the probe then only reports anchor stability across the detour, and a
    // taller paged window is needed to exercise the restore path.
    await world.setViewportSize({ width: 1_000, height: 400 })
    await world.waitForTimeout(300)
    const geometry = await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
      const range = element.scrollHeight - element.clientHeight
      element.scrollTop = Math.round(range * 0.4)
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
      element.dispatchEvent(new Event('scrollend', { bubbles: true }))
      return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, range, applied: element.scrollTop }
    })
    const readAnchor = () => world.evaluate(() => {
      const scroller = document.querySelector('[data-conversation-scroll]')
      const viewportTop = scroller?.getBoundingClientRect().top ?? 0
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow-key]'))
      const row = rows.find(candidate => candidate.getBoundingClientRect().top >= viewportTop) ?? null
      return {
        key: row?.getAttribute('data-chat-flow-key') ?? null,
        top: row === null ? null : row.getBoundingClientRect().top - viewportTop,
        scrollTop: scroller?.scrollTop ?? null,
      }
    })
    const before = await readAnchor()
    await clickTab(world, 'Trajectory')
    await waitTrajectory(world)
    await clickTab(world, 'Chat')
    await waitTranscript(world, ALPHA.id, ALPHA.tailMarker)
    await world.waitForTimeout(1_000)
    const after = await readAnchor()
    const state = await world.evaluate(() => {
      const chatSeat = document.querySelector('[data-view="chat"]')
      const scroller = document.querySelector('[data-conversation-scroll]')
      return {
        chatSeatActive: chatSeat?.getAttribute('data-active') ?? null,
        chatFlowNodes: document.querySelectorAll('[data-view="chat"] [data-chat-flow-key]').length,
        scrollTop: scroller?.scrollTop ?? null,
      }
    })
    // The retained seat must be active again and still carry the transcript
    // rows it had before the detour: a remount would have to refetch them.
    // When the window fits the viewport, the anchor cannot move either;
    // the seat contract itself stays a structural assertion.
    expect(state.chatSeatActive).toBe('true')
    expect(state.chatFlowNodes).toBeGreaterThan(0)
    console.info(`SWITCH_ANCHOR ${JSON.stringify({ geometry, before, after, state })}`)
  })
})
