import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { contactScheduling, stubContactApi } from '../test/contactApi'
import { renderApp } from '../test/render'

const step = (rank: number, fields: Record<string, number> = {}) => ({
  rank,
  step: rank === 0 ? 'contact' : `r${String(rank)}`,
  step_label: rank === 0 ? 'Contact' : `R${String(rank)}`,
  drafts: 0,
  validated: 0,
  scheduled: 0,
  due: 0,
  forgotten: 0,
  forgotten_none: 0,
  forgotten_draft: 0,
  forgotten_validated: 0,
  ...fields,
})

const panel = () => screen.findByRole('region', { name: /Suivi des envois programmés/ })

describe('Contact › Suivi des envois programmés', () => {
  it('counts what is scheduled, validated and in draft, by step and by day, and names who was forgotten', async () => {
    stubContactApi({
      scheduling: contactScheduling({
        totals: { scheduled: 5, validated: 2, drafts: 1, due: 6, forgotten: 3, scheduled_past: 0, scheduled_with_error: 0, scheduled_with_draft_error: 0 },
        steps: [
          step(0, { scheduled: 3, validated: 1, due: 4, forgotten: 1, forgotten_validated: 1 }),
          step(1, { scheduled: 2, validated: 1, drafts: 1, due: 2, forgotten: 2, forgotten_none: 1, forgotten_draft: 1 }),
          step(2),
        ],
        days: [
          { day: '2026-10-08', total: 3, by_step: { contact: 3 }, past: false },
          { day: '2026-10-09', total: 2, by_step: { r1: 2 }, past: false },
        ],
        forgotten: [
          {
            id: 'p1',
            first_name: 'Claire',
            last_name: 'Démo',
            civility: null,
            company_name: 'Bravo SA',
            cohort_code: 'S39',
            step: 'r1',
            step_label: 'R1',
            rank: 1,
            state: 'none',
            due_at: '2026-10-05T07:00:00Z',
            overdue: true,
          },
          {
            id: 'p2',
            first_name: 'Jean',
            last_name: 'Exemple',
            civility: null,
            company_name: null,
            cohort_code: 'S40',
            step: 'contact',
            step_label: 'Contact',
            rank: 0,
            state: 'validated',
            due_at: '2026-10-09T07:00:00Z',
            overdue: false,
          },
        ],
      }),
    })
    renderApp('/contact')

    const region = within(await panel())
    expect(await region.findByText('3 oubliés')).toBeInTheDocument()
    // Tiles: the four counts and what they mean.
    const tile = (label: string) => region.getAllByText(label).find((element) => element.className.includes('sched-tile__label'))
    expect(tile('Programmés')?.previousElementSibling).toHaveTextContent('5')
    expect(tile('Validés')?.previousElementSibling).toHaveTextContent('2')
    expect(tile('Brouillons')?.previousElementSibling).toHaveTextContent('1')
    // The chart is described in words, per day.
    expect(region.getByRole('img', { name: /jeu\. 08\/10 3, ven\. 09\/10 2/ })).toBeInTheDocument()
    // The table by step says how the forgotten split.
    const steps = region.getByRole('table', { name: /Par étape/ })
    expect(within(steps).getByRole('row', { name: /^R1/ })).toHaveTextContent('1 sans mail, 1 brouillon')
    // The forgotten stay folded until their tile is chosen; then: who, where, and what is missing, each opening the prospect.
    expect(region.queryByRole('link', { name: 'Claire Démo' })).not.toBeInTheDocument()
    await userEvent.click(region.getAllByRole('button', { name: /Oubliés/ })[0] as HTMLElement)
    expect(region.getByRole('link', { name: 'Claire Démo' })).toHaveAttribute('href', expect.stringContaining('prospect=p1'))
    expect(region.getByText('Rien d’écrit')).toBeInTheDocument()
    expect(region.getByText('Validé, à programmer')).toBeInTheDocument()
    expect(region.getByText('prévu le 05/10')).toBeInTheDocument()
    expect(region.queryByText(/retard/)).not.toBeInTheDocument()
    expect(region.getByText('Sans entreprise')).toBeInTheDocument()
  })

  it('opens the list behind a count of the table, for that step only', async () => {
    stubContactApi({
      scheduling: contactScheduling({
        totals: { scheduled: 0, validated: 0, drafts: 0, due: 2, forgotten: 2, scheduled_past: 0, scheduled_with_error: 0, scheduled_with_draft_error: 0 },
        steps: [
          step(0, { due: 1, forgotten: 1, forgotten_validated: 1 }),
          step(1, { due: 1, forgotten: 1, forgotten_none: 1 }),
        ],
        forgotten: [
          { id: 'p1', first_name: 'Claire', last_name: 'Démo', civility: null, company_name: 'Bravo SA', cohort_code: 'S39', step: 'r1', step_label: 'R1', rank: 1, state: 'none', due_at: '2026-10-05T07:00:00Z', overdue: true },
          { id: 'p2', first_name: 'Jean', last_name: 'Exemple', civility: null, company_name: null, cohort_code: 'S40', step: 'contact', step_label: 'Contact', rank: 0, state: 'validated', due_at: '2026-10-09T07:00:00Z', overdue: false },
        ],
      }),
    })
    renderApp('/contact')

    const region = within(await panel())
    await userEvent.click(await region.findByRole('button', { name: 'Oubliés R1 : 1, voir la liste' }))
    expect(region.getByRole('link', { name: 'Claire Démo' })).toBeInTheDocument()
    expect(region.queryByRole('link', { name: 'Jean Exemple' })).not.toBeInTheDocument()
    expect(region.getByText(/Étape : R1/)).toBeInTheDocument()
    await userEvent.click(region.getByRole('button', { name: 'Toutes les étapes' }))
    expect(region.getByRole('link', { name: 'Jean Exemple' })).toBeInTheDocument()
  })

  it('says nothing was forgotten, and warns about scheduled mails whose time passed', async () => {
    stubContactApi({
      scheduling: contactScheduling({
        totals: { scheduled: 2, validated: 0, drafts: 0, due: 2, forgotten: 0, scheduled_past: 1, scheduled_with_error: 1, scheduled_with_draft_error: 0 },
        steps: [step(0, { scheduled: 2, due: 2 })],
        days: [{ day: '2026-10-06', total: 2, by_step: { contact: 2 }, past: true }],
      }),
    })
    renderApp('/contact')

    const region = within(await panel())
    expect((await region.findAllByRole('button', { name: /Oubliés/ }))[0]).toBeDisabled()
    expect(region.queryByText(/oublié/)).not.toBeInTheDocument()
    expect(region.getByRole('alert')).toHaveTextContent('1 programmé(s) dont l’heure est passée sans envoi')
    expect(region.getByRole('alert')).toHaveTextContent('1 programmé(s) en erreur d’envoi')
    expect(region.getByText('passé')).toBeInTheDocument()
  })

  it('shows an empty state when nothing is scheduled yet', async () => {
    stubContactApi({})
    renderApp('/contact')

    expect(await within(await panel()).findByText('Aucun mail n’est programmé pour le moment.')).toBeInTheDocument()
  })
})

describe('Contact › Suivi des envois programmés › the tiles', () => {
  it('opens the list behind a tile, with a link to each prospect, and closes it again', async () => {
    const user = userEvent.setup()
    stubContactApi({
      scheduling: contactScheduling({
        totals: { scheduled: 1, validated: 0, drafts: 1, due: 0, forgotten: 0, scheduled_past: 0, scheduled_with_error: 0, scheduled_with_draft_error: 0 },
        steps: [step(0), step(1)],
        messages: [
          {
            prospect_id: 'p9',
            first_name: 'Marie',
            last_name: 'Calme',
            company_name: 'Delta SA',
            cohort_code: 'S39',
            step: 'r1',
            step_label: 'R1',
            rank: 1,
            status: 'draft',
            scheduled_at: null,
            last_error_code: null,
          },
          {
            prospect_id: 'p8',
            first_name: 'Jean',
            last_name: 'Exemple',
            company_name: 'Alpha SARL',
            cohort_code: 'S39',
            step: 'contact',
            step_label: 'Contact',
            rank: 0,
            status: 'scheduled',
            scheduled_at: '2026-10-12T06:00:00Z',
            last_error_code: 'toolbox_rejected',
          },
        ],
      }),
    })
    renderApp('/contact')

    const region = within(await panel())
    await user.click(await region.findByRole('button', { name: /Brouillons/ }))
    expect(region.getByRole('heading', { name: 'Brouillons à relire et valider (1)' })).toBeInTheDocument()
    expect(region.getByRole('link', { name: 'Marie Calme' })).toHaveAttribute('href', expect.stringContaining('prospect=p9'))
    expect(region.getByText('Brouillon à valider')).toBeInTheDocument()
    expect(region.queryByRole('link', { name: 'Jean Exemple' })).not.toBeInTheDocument()

    await user.click(region.getByRole('button', { name: /Programmés/ }))
    expect(region.getByRole('link', { name: 'Jean Exemple' })).toBeInTheDocument()
    expect(region.getByText('Erreur d’envoi : toolbox_rejected')).toBeInTheDocument()

    // A tile with nothing behind it does not open anything.
    expect(region.getByRole('button', { name: /Validés/ })).toBeDisabled()
    await user.click(region.getByRole('button', { name: /Programmés/ }))
    expect(region.queryByRole('link', { name: 'Jean Exemple' })).not.toBeInTheDocument()
  })
})
