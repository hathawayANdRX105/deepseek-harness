// @vitest-environment jsdom
/**
 * IME-commit selection guard: an insert input or composition end must leave
 * a collapsed caret after the committed text, even when the browser hands
 * back a selection spanning the inserted line (Firefox's element-point
 * quirk at a line start). The guard only touches the guard's own editor
 * methods, so these cases drive a minimal fake editor instead of a live
 * Lexical editor (whose own input handling would race the synthetic events
 * in jsdom); the real integration is covered by the web e2e lane.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type { LexicalEditor } from 'lexical'
import { registerInsertSelectionGuard } from '../src/client/input/editor/insert-selection-guard.ts'

/** Minimal editor: the guard's surface (`registerRootListener`, `getRootElement`, `isComposing`). */
function fakeEditor() {
  let rootElement: HTMLElement | null = null
  let composing = false
  const listeners = new Set<(root: HTMLElement | null, prevRoot: HTMLElement | null) => void>()
  const editor = {
    getRootElement: () => rootElement,
    isComposing: () => composing,
    registerRootListener: (listener: (root: HTMLElement | null, prevRoot: HTMLElement | null) => void) => {
      listeners.add(listener)
      listener(rootElement, null)
      return () => {
        listeners.delete(listener)
        listener(null, rootElement)
      }
    },
  } as unknown as LexicalEditor
  return {
    editor,
    setRoot: (root: HTMLElement | null): void => {
      const prevRoot = rootElement
      rootElement = root
      for (const listener of listeners) listener(root, prevRoot)
    },
    setComposing: (value: boolean): void => { composing = value },
  }
}

/** Composer root with the guard installed over a fake editor. */
function fixture() {
  const { editor, setRoot, setComposing } = fakeEditor()
  const root = document.createElement('div')
  root.contentEditable = 'true'
  root.innerHTML = '<p>你好</p>'
  document.body.append(root)
  const unregister = registerInsertSelectionGuard(editor)
  setRoot(root)
  onTestFinished(() => { unregister(); setRoot(null); root.remove() })
  return { editor, root, unregister, setRoot, setComposing }
}

/** Select the whole paragraph with a non-collapsed DOM range. */
function selectWholeParagraph(root: HTMLDivElement): void {
  const paragraph = root.querySelector('p')
  if (paragraph === null) throw new Error('missing paragraph')
  const child = paragraph.firstChild
  if (child === null) throw new Error('missing paragraph child')
  const range = document.createRange()
  range.setStart(child, 0)
  range.setEnd(child, 1)
  const selection = window.getSelection()
  if (selection === null) throw new Error('missing selection')
  selection.removeAllRanges()
  selection.addRange(range)
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('insert selection guard', () => {
  it('collapses a line-spanning selection after composition end', async () => {
    const { root } = fixture()
    selectWholeParagraph(root)
    expect(window.getSelection()?.isCollapsed).toBe(false)

    fireEvent.compositionEnd(root, { data: '你好' })
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(true)
  })

  it('collapses a line-spanning selection after a committed insert', async () => {
    const { root } = fixture()
    selectWholeParagraph(root)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(true)
  })

  it('ignores non-insert input events', async () => {
    const { root } = fixture()
    selectWholeParagraph(root)
    // A plain Event carries no inputType at all.
    root.dispatchEvent(new Event('input'))
    fireEvent.input(root, { inputType: 'deleteContentBackward' })
    fireEvent.input(root, {})
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(false)
  })

  it('ignores insert events without committed text', async () => {
    const { root } = fixture()
    selectWholeParagraph(root)
    fireEvent.input(root, { inputType: 'insertText' })
    fireEvent.input(root, { inputType: 'insertText', data: '' })
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(false)
  })

  it('ignores preedit updates of an open composition', async () => {
    const { root, setComposing } = fixture()
    setComposing(true)
    selectWholeParagraph(root)
    fireEvent.input(root, { inputType: 'insertCompositionText', data: '你', isComposing: true })
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(false)
  })

  it('repairs after the closing input of a committed composition', async () => {
    const { root } = fixture()
    selectWholeParagraph(root)
    // Firefox can deliver the closing insert with isComposing still true
    // after the editor already observed compositionend.
    fireEvent.input(root, { inputType: 'insertCompositionText', data: '你好', isComposing: true })
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(true)
  })

  it('returns early when selection is absent, empty, null-pointed, or the root is gone', async () => {
    const { root, setRoot } = fixture()
    const getSelection = vi.spyOn(window, 'getSelection')
    onTestFinished(() => { getSelection.mockRestore() })
    const realSelection = document.getSelection()

    // Absent selection at repair time.
    getSelection.mockReturnValueOnce(null)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    await settle()

    // Empty selection at repair time.
    getSelection.mockImplementation(() => realSelection)
    realSelection?.removeAllRanges()
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    await settle()

    // Selection with a null anchor at repair time.
    getSelection.mockReturnValueOnce({
      rangeCount: 1, isCollapsed: false, anchorNode: null, focusNode: null,
    } as unknown as Selection)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    await settle()

    // Selection with a null focus at repair time.
    const paragraph = root.querySelector('p')
    getSelection.mockReturnValueOnce({
      rangeCount: 1, isCollapsed: false, anchorNode: paragraph, focusNode: null,
    } as unknown as Selection)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    await settle()

    // Collapsed selection at repair time (the ordinary no-op case).
    getSelection.mockImplementation(() => realSelection)
    selectWholeParagraph(root)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    const selection = document.getSelection()
    if (selection !== null && selection.anchorNode !== null) {
      selection.collapse(selection.anchorNode, selection.anchorOffset)
    }
    await settle()

    // No editor root at repair time.
    getSelection.mockImplementation(() => realSelection)
    selectWholeParagraph(root)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    setRoot(null)
    selectWholeParagraph(root)
    await settle()
  })

  it('returns early when the selection leaves the editor root', async () => {
    const { root } = fixture()
    const outside = document.createElement('div')
    outside.textContent = 'outside'
    document.body.append(outside)
    onTestFinished(() => { outside.remove() })
    const selection = window.getSelection()
    if (selection === null) throw new Error('missing selection')

    // Anchor and focus both outside the root.
    const range = document.createRange()
    range.selectNodeContents(outside)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.compositionEnd(root, { data: '' })
    await settle()
    expect(selection.isCollapsed).toBe(false)

    // Anchor inside the root, focus outside it.
    const paragraph = root.querySelector('p')
    if (paragraph === null) throw new Error('missing paragraph')
    const child = paragraph.firstChild
    if (child === null) throw new Error('missing paragraph child')
    const crossing = document.createRange()
    const outsideText = outside.firstChild
    if (outsideText === null) throw new Error('missing outside text')
    crossing.setStart(child, 0)
    crossing.setEnd(outsideText, 1)
    selection.removeAllRanges()
    selection.addRange(crossing)
    fireEvent.compositionEnd(root, { data: '' })
    await settle()
    expect(selection.isCollapsed).toBe(false)
  })

  it('detaches listeners when the editor root swaps', async () => {
    const { root, setRoot } = fixture()
    const second = document.createElement('div')
    second.contentEditable = 'true'
    document.body.append(second)
    onTestFinished(() => { setRoot(null); second.remove() })
    setRoot(second)

    // The old root no longer carries the guard's listeners.
    selectWholeParagraph(root)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    fireEvent.compositionEnd(root, { data: '' })
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(false)
  })

  it('detaches listeners when the guard is disposed', async () => {
    const { root, unregister, setRoot } = fixture()
    unregister()
    setRoot(null)

    selectWholeParagraph(root)
    fireEvent.input(root, { inputType: 'insertText', data: 'x', isComposing: false })
    fireEvent.compositionEnd(root, { data: '' })
    await settle()
    expect(window.getSelection()?.isCollapsed).toBe(false)
  })
})
