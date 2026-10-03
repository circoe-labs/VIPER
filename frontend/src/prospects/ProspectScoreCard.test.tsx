import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ProspectScore, ScoreBand, ScoreContribution } from '../api/prospects'
import { ProspectScoreCard } from './ProspectScoreCard'

function contribution(id: string, delta: number, fields: Partial<ScoreContribution> = {}): ScoreContribution {
  return { id, delta, reason: `Raison ${id}`, source_type: 'note', source_ref: `note-${id}`, created_at: '2026-09-10T08:00:00+00:00', origin: 'manual', ...fields }
}

function score(total: number, band: ScoreBand, contributions: ScoreContribution[] = [], summary = 'Un résumé.'): ProspectScore {
  return { total, band, summary, contributions }
}

function show(value: ProspectScore | null, extra: { outdated?: boolean; onShowNote?: (id: string) => void } = {}) {
  const onShowNote = extra.onShowNote ?? vi.fn()
  render(<ProspectScoreCard score={value} outdated={extra.outdated} onShowNote={onShowNote} />)
  return { onShowNote }
}

const card = () => screen.getByRole('button', { name: /^Score prospect/ })

describe('ProspectScoreCard - the card', () => {
  it.each<[number, ScoreBand, string]>([
    [0, 'red', 'Faible'],
    [1, 'red', 'Faible'],
    [50, 'yellow', 'Moyen'],
    [99, 'green', 'Élevé'],
    [100, 'green', 'Élevé'],
  ])('shows %i with the band %s as the word %s, in the name and the text', (total, band, word) => {
    show(score(total, band))

    expect(card()).toHaveAccessibleName(`Score prospect : ${String(total)} sur 100, niveau ${word.toLowerCase()}. Voir le détail`)
    expect(within(card()).getByText(word)).toBeInTheDocument()
    expect(card()).toHaveTextContent(String(total))
    expect(card()).toHaveAttribute('data-band', band)
  })

  it('applies no threshold of its own: a 5 labelled green stays green', () => {
    show(score(5, 'green'))

    expect(within(card()).getByText('Élevé')).toBeInTheDocument()
  })

  it('shows the summary next to the ring, whole as its tooltip when it is long', () => {
    const long = 'Contact très engagé. '.repeat(30).trim()
    show(score(80, 'green', [], long))

    const summary = card().querySelector('.prospect-score__summary')
    expect(summary).toHaveTextContent('Contact très engagé.')
    expect(summary).toHaveAttribute('title', long)
    expect(card()).toHaveAccessibleDescription(long)
  })

  it('shows nothing, and takes no room, when there is no score', () => {
    show(null)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Score prospect' })).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="prospect-score"]')).toBeEmptyDOMElement()
  })

  it('warns when the last refresh failed', () => {
    show(score(50, 'yellow'), { outdated: true })

    expect(screen.getByRole('status')).toHaveTextContent('Mise à jour impossible : ce score peut être périmé.')
  })
})

describe('ProspectScoreCard - the detail', () => {
  it('opens with the click, then returns the focus to the card on Escape', async () => {
    show(score(60, 'yellow', [contribution('a', 5)]))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(card())
    const dialog = screen.getByRole('dialog', { name: 'Détail du score' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(card()).toHaveFocus()
  })

  it.each([['{Enter}'], [' ']])('opens from the keyboard (%j) and closes with the button', async (key) => {
    show(score(60, 'yellow'))

    await userEvent.tab()
    expect(card()).toHaveFocus()
    await userEvent.keyboard(key)
    const dialog = screen.getByRole('dialog', { name: 'Détail du score' })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(card()).toHaveFocus()
  })

  it('traps the focus inside the dialog', async () => {
    show(score(60, 'yellow', [contribution('a', 5)]))
    await userEvent.click(card())
    const dialog = screen.getByRole('dialog')

    for (let step = 0; step < 4; step++) {
      await userEvent.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
  })

  it('says that there is no signal when the breakdown is empty', async () => {
    show(score(50, 'yellow'))
    await userEvent.click(card())

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Aucun signal enregistré : le score est à sa valeur de départ.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('list')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Un résumé.')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('50 sur 100 · niveau moyen')
  })

  it('lists positives from the largest, then negatives from the most damaging, with sign, reason and source', async () => {
    show(
      score(55, 'yellow', [
        contribution('petit-moins', -5),
        contribution('petit-plus', 3),
        contribution('gros-moins', -20),
        contribution('gros-plus', 25, { source_type: null, source_ref: null }),
      ]),
    )
    await userEvent.click(card())

    const items = within(screen.getByRole('list', { name: 'Contributions au score' })).getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('.prospect-score-detail__reason')?.textContent)).toEqual([
      'Raison gros-plus',
      'Raison petit-plus',
      'Raison gros-moins',
      'Raison petit-moins',
    ])
    expect(within(items[0] as HTMLElement).getByRole('img', { name: '+25 points' })).toHaveTextContent('+25')
    expect(within(items[0] as HTMLElement).getByText('Source non précisée')).toBeInTheDocument()
    expect(within(items[2] as HTMLElement).getByRole('img', { name: '-20 points' })).toHaveTextContent('-20')
    expect(within(items[2] as HTMLElement).getByText('Note du prospect')).toBeInTheDocument()
  })

  it('keeps a very long reason whole, in its row', async () => {
    const reason = `${'Longue raison sans fin '.repeat(40)}${'x'.repeat(80)}`
    show(score(60, 'yellow', [contribution('a', 10, { reason })]))
    await userEvent.click(card())

    expect(screen.getByText(reason)).toHaveClass('prospect-score-detail__reason')
  })

  it('offers Voir la note only for a note source, closes the detail and gives the note id', async () => {
    const { onShowNote } = show(score(60, 'yellow', [contribution('a', 10), contribution('b', 5, { source_type: 'rule', source_ref: 'r1' })]))
    await userEvent.click(card())

    expect(screen.getAllByRole('button', { name: 'Voir la note' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Voir la note' }))

    expect(onShowNote).toHaveBeenCalledWith('note-a')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
