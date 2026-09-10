import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

import { expect, test } from '@playwright/test'

import { createCompany, uniqueSuffix } from './data'
import { signIn } from './session'

// Normalized Excel export (Task 10) against the real backend: the button downloads the whole database as a workbook.
// The test owns one invented company (I-81) and only checks that it is in the file — never a global count.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

// One entry of a zip archive (an XLSX is one), read with Node's own zlib: the central directory gives each entry's
// method, size and local header.
function zipEntry(archive: Buffer, name: string): string {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end, 'end of central directory').toBeGreaterThan(0)
  let offset = archive.readUInt32LE(end + 16)
  for (let index = 0; index < archive.readUInt16LE(end + 10); index += 1) {
    const method = archive.readUInt16LE(offset + 10)
    const size = archive.readUInt32LE(offset + 20)
    const nameLength = archive.readUInt16LE(offset + 28)
    const skip = nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32)
    const local = archive.readUInt32LE(offset + 42)
    if (archive.toString('utf8', offset + 46, offset + 46 + nameLength) === name) {
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
      const data = archive.subarray(start, start + size)
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8')
    }
    offset += 46 + skip
  }
  throw new Error(`${name} is not in the archive`)
}

test('Exporter Excel downloads the normalized workbook, with the data just saved', async ({ page }) => {
  const name = `Transports Export ${uniqueSuffix()}`
  await createCompany(page, { display_name: name })
  await page.goto('/prospection/companies')
  await expect(page.getByRole('heading', { level: 1, name: 'Entreprises' })).toBeVisible()

  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exporter Excel' }).click()
  const download = await downloading

  expect(download.suggestedFilename()).toMatch(/^VIPER_export_\d{4}-\d{2}-\d{2}\.xlsx$/)
  const archive = await readFile(await download.path())
  expect(archive.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04', 'latin1'))
  const workbook = zipEntry(archive, 'xl/workbook.xml')
  for (const sheet of ['Prospects', 'Entreprises', 'E-mails', 'Téléphones', "Données d'origine"]) {
    expect(workbook).toContain(`name="${sheet}"`)
  }
  expect(zipEntry(archive, 'xl/worksheets/sheet2.xml')).toContain(`<t>${name}</t>`)
  await expect(page.getByRole('button', { name: 'Exporter Excel' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
