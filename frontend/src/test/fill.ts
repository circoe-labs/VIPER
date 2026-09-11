import userEvent from '@testing-library/user-event'

// Enters a whole value in one input event. Component tests type key by key only where keystrokes are the behaviour
// under test (pickers, Enter or Ctrl+S, live validation): typing long values through a large editor made flows slow
// enough to approach Vitest's 5 s limit on a loaded machine.
export async function fill(element: HTMLElement, text: string): Promise<void> {
  await userEvent.clear(element)
  await userEvent.paste(text)
}
