import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { company } from '../test/companiesApi'
import { prospect } from '../test/prospectionApi'
import { companySummary, lastBody, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
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

function people() {
  const anne = prospectDetail({
    first_name: 'Anne',
    last_name: 'Premier',
    company: companySummary(employer),
    emails: [email('anne@exemple.test')],
  })
  const bruno = prospectDetail({
    first_name: 'Bruno',
    last_name: 'Second',
    company: companySummary(employer),
    emails: [email('bruno@exemple.test')],
  })
  const rows = [
    prospect('Anne', 'Premier', { id: anne.id }, ['never_verified']),
    prospect('Bruno', 'Second', { id: bruno.id }, ['never_verified']),
  ]
  return stubProspectsApi({ details: [anne, bruno], rows, companies: [employer] })
}

describe('Espace de vérification', () => {
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

  it('renames the company when its name was edited, then validates', async () => {
    const api = people()
    renderApp('/prospection/verification')
    const field = await screen.findByLabelText('Entreprise')
    await userEvent.clear(field)
    await userEvent.type(field, 'Transports Exemple Groupe')

    await userEvent.click(screen.getByRole('button', { name: 'Valider et suivant' }))

    expect(await screen.findByDisplayValue('Second')).toBeInTheDocument()
    expect(api.companies.find((row) => row.id === employer.id)?.display_name).toBe('Transports Exemple Groupe')
  })

  it('lets you type a phone number when the fiche has none, and saves it verified', async () => {
    const api = people()
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
