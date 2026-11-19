import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Config AI › Connexions in component tests: a connection is a tile of the grid; its settings live in its dialog.

// The tile of a connection (its status badge and its quick test button).
export async function tile(title: string) {
  return within(await screen.findByRole('article', { name: title }))
}

// Clicks the tile, then (optionally) a sub-tab of the dialog; answers the queries inside the dialog. Only the shown
// tab's controls are reachable by role (the other panes stay mounted but hidden).
export async function openConnection(title: string, tab?: string) {
  const open = screen.queryByRole('dialog', { name: title })
  if (!open) await userEvent.click(await screen.findByRole('button', { name: `Configurer ${title}` }))
  const dialog = await screen.findByRole('dialog', { name: title })
  const queries = within(dialog)
  if (tab) await userEvent.click(queries.getByRole('tab', { name: tab }))
  return queries
}
