// Regression e2e for the composer IME-commit selection guard.
//
// After an IME commit at a line start, Firefox can leave the DOM selection as
// an element-point range bracketing the just-inserted line (`<p,0>`..`<p,1>`);
// Lexical maps it to a selection spanning the whole line, so the next
// keystroke replaces the line instead of continuing it. The composer guard
// collapses such a selection right after composition end. This scenario
// simulates that browser state in Chromium and asserts the user-visible
// outcome: the caret lands after the committed text and typing continues it.
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

function composerInput(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-composer-input][contenteditable="true"]').first()
}

async function selectionState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const selection = window.getSelection()
    const input = document.querySelector('[data-composer-input][contenteditable="true"]')
    return {
      collapsed: selection ? selection.isCollapsed : null,
      selectedText: selection ? selection.toString() : null,
      anchor: selection && selection.anchorNode
        ? `${selection.anchorNode.nodeName}@${selection.anchorOffset}`
        : null,
      draft: input ? input.textContent : null,
    }
  })
}

describe('web e2e: composer IME-commit selection guard', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'ime-selection-guard')
  }, 240_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('collapses a line-spanning selection left by an IME commit at line start', async () => {
    const input = composerInput(page)
    await input.click()
    await page.keyboard.press('ControlOrMeta+KeyA')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText('你好')
    await page.waitForTimeout(200)

    // Firefox leaves an element-point range bracketing the just-inserted
    // line after an IME commit at a line start. Force exactly that state.
    await page.evaluate(() => {
      const paragraph = document.querySelector('[data-composer-input][contenteditable="true"] p')
      if (paragraph === null) throw new Error('missing composer paragraph')
      const selection = window.getSelection()
      if (selection === null) throw new Error('missing selection')
      selection.setBaseAndExtent(paragraph, 0, paragraph, 1)
    })
    await page.waitForTimeout(100)
    const bracketed = await selectionState(page)
    expect(bracketed.collapsed).toBe(false)
    expect(bracketed.selectedText).toBe('你好')

    // Dispatch the closing composition event the browser sends on commit.
    await page.evaluate(() => {
      const input = document.querySelector('[data-composer-input][contenteditable="true"]')
      if (input === null) throw new Error('missing composer input')
      input.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        cancelable: false,
        data: '你好',
      }))
    })

    // The guard collapses the selection to the caret after the committed text.
    await expect.poll(async () => (await selectionState(page)).collapsed, { timeout: 5000 }).toBe(true)
    expect(await selectionState(page)).toMatchObject({ selectedText: '' })
    await page.waitForTimeout(100)

    // The next keystroke continues the line instead of replacing it.
    await page.keyboard.type('x')
    await expect.poll(async () => (await selectionState(page)).draft, { timeout: 5000 }).toBe('你好x')
  }, 60_000)
})
