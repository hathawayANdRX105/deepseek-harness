/** Account and Session menus share the opaque menu material across palettes. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'

const expected = fileURLToPath(new URL('./expected/menu-material', import.meta.url))
const seed = new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url)

async function material(menu: Locator) {
  return menu.evaluate((node) => {
    const style = getComputedStyle(node)
    const background = getComputedStyle(node.querySelector(':scope > [aria-hidden="true"]')!)
    return { fill: background.backgroundColor, blur: background.backdropFilter, radius: style.borderRadius, shadow: style.boxShadow }
  })
}

it('shares opaque menu surfaces across palettes and keeps modal masks translucent', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(seed, 'utf8'), 'menu-material-session')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const account = page.getByRole('button', { name: 'Account menu', exact: true })
  await account.waitFor({ timeout: 30_000 })

  const results: Record<string, Awaited<ReturnType<typeof material>>> = {}
  const masks: Record<string, { fill: string; blur: string }> = {}
  for (const platform of ['web', 'darwin']) {
    for (const dark of [false, true]) {
      await page.evaluate(({ platform, dark }) => {
        if (platform === 'darwin') document.documentElement.dataset.platform = platform
        else delete document.documentElement.dataset.platform
        document.body.toggleAttribute('data-ds-dark-theme', dark)
      }, { platform, dark })
      const overlayFill = await page.evaluate(() => {
        const overlay = document.createElement('div')
        overlay.style.background = 'var(--dsw-specific-menu)'
        document.body.appendChild(overlay)
        try { return getComputedStyle(overlay).backgroundColor } finally { overlay.remove() }
      })
      expect(overlayFill).toBe(platform === 'darwin'
        ? dark ? 'rgb(48, 49, 54)' : 'rgb(248, 249, 250)'
        : dark ? 'rgb(67, 69, 74)' : 'rgb(248, 249, 250)')
      await account.click()
      const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Settings', exact: true }) })
      await menu.waitFor()
      const appearance = await material(menu)
      expect(appearance).toMatchObject({
        fill: dark ? 'rgb(67, 69, 74)' : 'rgb(248, 249, 250)',
        blur: 'none',
      })
      expect(appearance.shadow).toContain(`${dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.04)'} 0px 0px 0px 0.5px`)
      results[`${platform}-${dark ? 'dark' : 'light'}`] = appearance
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'hidden' })
      await account.click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      const mask = await settings.locator('..').locator(':scope > [aria-hidden="true"]').evaluate((node) => {
        const style = getComputedStyle(node)
        return { fill: style.backgroundColor, blur: style.backdropFilter }
      })
      expect(mask).toEqual({ fill: dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.24)', blur: 'none' })
      masks[`${platform}-${dark ? 'dark' : 'light'}`] = mask
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
    }
  }
  await compareOrRefreshGolden(join(expected, 'materials.expected.json'), JSON.stringify(results, null, 2), webSnapshotMode())
  await compareOrRefreshGolden(join(expected, 'modal-masks.expected.json'), JSON.stringify(masks, null, 2), webSnapshotMode())

  const ungrouped = page.getByText('Ungrouped', { exact: true })
  const group = ungrouped.locator('xpath=ancestor::*[@aria-expanded][1]')
  await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
  const action = page.locator('button[aria-label^="Session actions for "]').first()
  await action.locator('xpath=ancestor::*[@role="treeitem"][1]').hover()
  await action.click()
  const sessionMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Rename', exact: true }) })
  await sessionMenu.waitFor()
  expect(await material(sessionMenu)).toEqual(results['darwin-dark'])
  await compareOrRefreshGolden(join(expected, 'session-menu.expected.md'),
    await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'hidden' })
})
