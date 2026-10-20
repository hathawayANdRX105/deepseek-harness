/** Shared menu material, painted opaquely by the theme-owned menu fill. */
import { forwardRef, useId, type ComponentPropsWithoutRef, type CSSProperties } from 'react'
import clsx from 'clsx'
import css from './MenuSurface.module.css'

/** Menu containers preserve native div props and refs. */
export interface MenuSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** Match the shared compact menu's smaller outer radius. */
  compact?: boolean
}

/**
 * Paint a menu over the opaque theme-owned menu fill.
 * @param props - Div content and placement, and compact geometry.
 * @param ref - The visible menu div.
 * @returns the menu content and its isolated background layer.
 */
export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface({
  compact = false, className, style, children, ...props
}, ref) {
  const id = useId()
  const anchorStyle: CSSProperties & { '--dsh-menu-anchor': string } = {
    '--dsh-menu-anchor': `--dsh-menu-${id.replaceAll(':', '')}`,
  }
  return (
    <div {...props} ref={ref} data-menu-material="opaque"
      className={clsx(css.surface, compact && css.compact, className)} style={{ ...style, ...anchorStyle }}>
      <div aria-hidden="true" className={css.material} />
      {children}
    </div>
  )
})
