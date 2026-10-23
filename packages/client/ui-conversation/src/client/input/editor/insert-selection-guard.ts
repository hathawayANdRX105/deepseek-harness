/**
 * Composer IME-commit selection guard.
 *
 * When an IME commits text at a paragraph's element-point caret (an empty
 * line, or the start of a line), Firefox can leave the DOM selection as a
 * non-collapsed element-point range that brackets the just-inserted child
 * (e.g. `<p,0>`..`<p,1>`). Lexical maps such a range to a selection spanning
 * the whole committed line, so the next keystroke replaces the line instead
 * of continuing it. The guard repairs that state: after any insert input
 * event or composition end, it collapses a non-collapsed selection that
 * remains inside the editor root to the selection's focus end — the caret
 * position the IME intended.
 */
import type { LexicalEditor } from 'lexical'

/**
 * Install the composer IME-commit selection guard on one editor.
 * @param editor - the shell-owned editor.
 * @returns the unregister disposer (also detaches the root listeners).
 */
export function registerInsertSelectionGuard(editor: LexicalEditor): () => void {
  const repair = (): void => {
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return
    if (selection.isCollapsed) return
    const root = editor.getRootElement()
    if (root === null) return
    const anchor = selection.anchorNode
    const focus = selection.focusNode
    if (anchor === null || focus === null) return
    if (!root.contains(anchor) || !root.contains(focus)) return
    // The browser must place the caret after an insert; a selection left over
    // by an IME commit at a block boundary makes the next keystroke replace
    // the committed line instead of continuing it.
    selection.collapse(focus, selection.focusOffset)
  }
  const scheduleRepair = (): void => { setTimeout(repair, 0) }
  const onInsert = (event: Event): void => {
    const input = event as InputEvent
    if (typeof input.inputType !== 'string' || !input.inputType.startsWith('insert')) return
    if (typeof input.data !== 'string' || input.data.length === 0) return
    // The editor still tracks an active composition when the browser reports
    // a preedit update; its composing range must survive until the commit.
    if (input.isComposing && editor.isComposing()) return
    scheduleRepair()
  }
  const onCompositionEnd = (): void => { scheduleRepair() }
  return editor.registerRootListener((root, prevRoot) => {
    prevRoot?.removeEventListener('input', onInsert)
    prevRoot?.removeEventListener('compositionend', onCompositionEnd)
    root?.addEventListener('input', onInsert)
    root?.addEventListener('compositionend', onCompositionEnd)
  })
}
