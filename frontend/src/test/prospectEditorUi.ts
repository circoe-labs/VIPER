import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Moves around the Prospect editor's tabs and read/edit sections in tests (the same gestures as a person's).

// The editor shows its Profil tab once the prospect is loaded.
export async function editorReady() {
  await screen.findByRole('region', { name: 'Identité' })
}

export async function showTab(name: 'Profil' | 'Suivi') {
  await userEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }))
}

// « Modifier » on a Profil section (Identité, Emploi, E-mails, Téléphones): its inputs replace the summary.
export async function editSection(name: string) {
  const section = screen.getByRole('region', { name })
  await userEvent.click(within(section).getByRole('button', { name: `Modifier : ${name}` }))
}
