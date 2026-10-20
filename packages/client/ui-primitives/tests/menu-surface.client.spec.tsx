// @vitest-environment jsdom
/** Menu surface placement identity and visibility propagation. */
import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MenuSurface } from '../src/MenuSurface.tsx'

afterEach(cleanup)

it('gives each menu its own anchor and removes it when unmounted', () => {
  const ref = createRef<HTMLDivElement>()
  const view = render(<MenuSurface ref={ref} role="menu" compact><button>Action</button></MenuSurface>)
  const menu = screen.getByRole('menu')
  expect(ref.current).toBe(menu)
  expect(menu.style.getPropertyValue('--dsh-menu-anchor')).not.toBe('')
  view.unmount()
  expect(screen.queryByRole('menu')).toBeNull()
})

it('gives simultaneously open menus independent anchors and follows visibility changes', () => {
  const view = render(<><MenuSurface role="menu" /><MenuSurface role="menu" /></>)
  const anchors = screen.getAllByRole('menu').map(menu => menu.style.getPropertyValue('--dsh-menu-anchor'))
  expect(new Set(anchors).size).toBe(2)
  view.rerender(<MenuSurface role="menu" style={{ visibility: 'hidden' }} />)
  expect(screen.getByRole('menu', { hidden: true }).style.visibility).toBe('hidden')
})
