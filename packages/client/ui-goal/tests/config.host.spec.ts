/**
 * The Host half of the auto-goal preference: the `ui-goal` settings namespace
 * the browser half reads and writes through the shared configuration form.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import { Config, apply, name } from '../src/index.ts'

describe('ui-goal Host settings', () => {
  it('registers the auto-goal namespace and validates its value', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply, name })
    const { fiber } = configuration

    // The namespace id is the plugin's own name; the browser half addresses
    // the same form.
    expect(configuration.entry.options.id).toBe('ui-goal')
    expect(plainConfig(configuration.fiber.config)).toEqual({ autoGoal: false })
    await configuration.update({ autoGoal: true })
    expect(plainConfig(configuration.fiber.config)).toEqual({ autoGoal: true })
    await expect(configuration.update({ autoGoal: 'yes' })).rejects.toThrow()

    await fiber.dispose()
  })

  it('loads without a settings provider', async () => {
    const ctx = new Context()
    await expect(ctx.plugin({ Config, apply }).await()).resolves.toBeDefined()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
