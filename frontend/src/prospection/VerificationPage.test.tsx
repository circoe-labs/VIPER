import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { company } from '../test/companiesApi'
import { prospect } from '../test/prospectionApi'
import { companySummary, lastBody, prospectDetail, qualityAlert, stubProspectsApi } from '../test/prospectsApi'
import { renderApp } from '../test/render'

const employer = company('Transports Exemple SARL')

function email(address: string) {
  return {
    id: `mail-${address}`,
    address,
    is_primary: true,
    is_active: true,
    verification_status: 'unverified' as const,
    last_verified_at: null,
    origin_type: 'imported' as const,
    source_reference: null,
    imported_unverified: true,
  }
}

function phone(number: string) {
  return { ...email(number), number, address: undefined, type: 'landline' as const }
}

// Complete fiches (nothing missing) unless `withPhone` is off.
function people({ withPhone = true }: { withPhone?: boolean } = {}) {
  const complete = {
    civility: 'mr' as const,
    exact_job_title: 'Directeur',
    company: companySummary(employer),
  }
  const anne = prospectDetail({
    ...complete,
    first_name: 'Anne',
    last_name: 'Premier',
    emails: [email('anne@exemple.test')],
    phones: withPhone ? [phone('+33235226424')] : [],
  })
  const bruno = prospectDetail({
    ...complete,
    first_name: 'Bruno',
    last_name: 'Second',
    emails: [email('bruno@exemple.test')],
    phones: withPhone ? [phone('+33235226425')] : [],
  })
  const rows = [
    prospect('Anne', 'Premier', { id: anne.id }, ['never_verified']),
    prospect('Bruno', 'Second', { id: bruno.id }, ['never_verified']),
  ]
  return stubProspectsApi({ details: [anne, bruno], rows, companies: [employer] })
}

function pagedPeople(uncertainCount: number, remaining: number) {
  const details = Array.from({ length: uncertainCount + remaining }, (_, index) => prospectDetail({
    civility: 'mr',
    first_name: 'Personne',
    last_name: `Fiche ${String(index + 1)}`,
    exact_job_title: 'Directeur',
    company: companySummary(employer),
    emails: [email(`personne${String(index)}@exemple.test`)],
    phones: [phone('+33235226424')],
  }))
  const rows = details.map((detail) => prospect('Personne', detail.last_name ?? '', { id: detail.id }, ['never_verified']))
  const api = stubProspectsApi({
    details,
    rows,
    companies: [employer],
    alerts: details.slice(0, uncertainCount).map((detail) => qualityAlert({ prospect_id: detail.id })),
  })
  return { api, rows }
}

describe('Espace de vérification', () => {
  it('finds the remaining fiche beyond a whole page of doubts, and lets you resume it after a skip', async () => {
    pagedPeople(50, 1)
    renderApp('/prospection/verification')

    expect(await screen.findByDisplayValue('Fiche 51')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Reprendre les fiches passées' }))

    expect(await screen.findByDisplayValue('Fiche 51')).toBeInTheDocument()
  })

  it('keeps later fiches accessible when a validation shrinks the pages, then resumes skipped fiches', async () => {
    const { rows } = pagedPeople(49, 3)
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Fiche 50')
    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))
    await screen.findByDisplayValue('Fiche 51')

    // Saving removes this fiche from the server list, moving fiche 52 up one place.
    rows.splice(50, 1)
    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))
    expect(await screen.findByDisplayValue('Fiche 52')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Reprendre les fiches passées' }))

    expect(await screen.findByDisplayValue('Fiche 50')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))
    expect(await screen.findByDisplayValue('Fiche 52')).toBeInTheDocument()
  })

  it('does not count a skipped fiche twice when revisiting it', async () => {
    people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')
    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))
    await screen.findByDisplayValue('Second')
    await userEvent.click(screen.getByRole('button', { name: 'Retour' }))
    await screen.findByDisplayValue('Premier')
    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))

    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
    expect(screen.getByText(/1 passée/)).toBeInTheDocument()
  })

  it('shows the first fiche to verify and the number left', async () => {
    people()
    renderApp('/prospection/verification')

    expect(await screen.findByDisplayValue('Premier')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /À vérifier/ })).toHaveTextContent('2')
  })

  it('opens the reading of a box: the verified by cohort', async () => {
    people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')

    await userEvent.click(screen.getByRole('button', { name: /Vérifié/ }))

    expect(await screen.findByText('Combien de vérifiés dans quelle cohorte ?')).toBeInTheDocument()
  })

  it('validates: employment and primary e-mail verified, then the next fiche comes up', async () => {
    const api = people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')

    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
    const body = lastBody(api.requests, 'PUT') as {
      employment_verification: { action: string }
      emails: { verified_now: boolean }[]
    }
    expect(body.employment_verification.action).toBe('verified_now')
    expect(body.emails[0]?.verified_now).toBe(true)
  })

  it('keeps the company untouched when its name is not edited', async () => {
    const api = people()
    renderApp('/prospection/verification')
    expect(await screen.findByLabelText('Entreprise')).toHaveValue('Transports Exemple SARL')

    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
    expect(api.requests.some((request) => request.method !== 'GET' && request.path.includes('/companies'))).toBe(false)
  })

  it('moves only this fiche to a new company typed as plain text, never renaming the shared one', async () => {
    const api = people()
    renderApp('/prospection/verification')
    const field = await screen.findByLabelText('Entreprise')
    await userEvent.clear(field)
    await userEvent.type(field, 'Nouvelle Société')

    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
    expect(api.companies.find((row) => row.id === employer.id)?.display_name).toBe('Transports Exemple SARL')
    expect(api.requests.some((request) => request.method === 'PUT' && request.path.includes('/companies'))).toBe(false)
    const created = api.companies.find((row) => row.display_name === 'Nouvelle Société')
    expect(created).toBeDefined()
    expect((lastBody(api.requests, 'PUT') as { company_id: string }).company_id).toBe(created?.id)
  })

  it('marks the empty boxes in red on « Valider » and validates on the second press', async () => {
    const api = people({ withPhone: false })
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')

    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    expect(await screen.findByText('À compléter')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Il manque : téléphone')
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: 'Valider quand même' }))
    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
  })

  it('lets you type a phone number when the fiche has none, and saves it verified', async () => {
    const api = people({ withPhone: false })
    renderApp('/prospection/verification')
    const phone = await screen.findByLabelText('Téléphone')
    expect(phone).toBeEnabled()
    await userEvent.type(phone, '02 35 22 64 24')

    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    await screen.findByDisplayValue('Second')
    const body = lastBody(api.requests, 'PUT') as { phones: { number: string; type: string; verified_now: boolean }[] }
    expect(body.phones).toMatchObject([{ number: '02 35 22 64 24', type: 'landline', verified_now: true }])
  })

  it('lets you add a second e-mail, saved with the first and both verified', async () => {
    const api = people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un e-mail' }))
    await userEvent.type(screen.getByLabelText('E-mail 2'), 'anne.autre@exemple.test')
    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    await screen.findByDisplayValue('Second')
    const body = lastBody(api.requests, 'PUT') as { emails: { address: string; is_primary: boolean; verified_now: boolean }[] }
    expect(body.emails).toMatchObject([
      { address: 'anne@exemple.test', is_primary: true, verified_now: true },
      { address: 'anne.autre@exemple.test', is_primary: false, verified_now: true },
    ])
  })

  it('says what blocks the validation instead of sending it', async () => {
    const orphan = prospectDetail({ first_name: 'Carl', last_name: 'Sansentreprise' })
    const api = stubProspectsApi({
      details: [orphan],
      rows: [prospect('Carl', 'Sansentreprise', { id: orphan.id }, ['never_verified'])],
    })
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Sansentreprise')

    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('entreprise')
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([])
  })

  it('« Passer » moves on without writing anything', async () => {
    const api = people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')

    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))

    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([])
  })

  it('« Retour » shows the previous fiche again, and is disabled on the first one', async () => {
    people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')
    expect(screen.getByRole('button', { name: 'Retour' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Passer' }))
    await screen.findByDisplayValue('Second')
    await userEvent.click(screen.getByRole('button', { name: 'Retour' }))

    expect(await screen.findByDisplayValue('Premier')).toBeInTheDocument()
  })

  it('« Incertain » records the doubt on the fiche and says so', async () => {
    const api = people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')

    await userEvent.click(screen.getByRole('button', { name: 'Incertain' }))

    expect(await screen.findByText(/Incertitude notée sur la fiche de Anne Premier/)).toBeInTheDocument()
    expect(api.alerts.some((alert) => alert.type === 'function_to_check')).toBe(true)
    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
  })

  it('asks for a confirmation before ignoring', async () => {
    const api = people()
    renderApp('/prospection/verification')
    await screen.findByDisplayValue('Premier')

    await userEvent.click(screen.getByRole('button', { name: 'Ignorer' }))

    expect(screen.getByRole('button', { name: 'Confirmer : ignorer définitivement' })).toBeInTheDocument()
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([])
  })
})
