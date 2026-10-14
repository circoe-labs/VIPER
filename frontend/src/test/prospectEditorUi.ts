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

// « Modifier » on a Profil section (Identité, Emploi, Coordonnées): its inputs replace the summary. E-mails and
// Téléphones are the two halves of Coordonnées: one switch opens both.
export async function editSection(name: string) {
  const owner = name === 'E-mails' || name === 'Téléphones' ? 'Coordonnées' : name
  const section = screen.getByRole('region', { name: owner })
  await userEvent.click(within(section).getByRole('button', { name: `Modifier : ${owner}` }))
}
