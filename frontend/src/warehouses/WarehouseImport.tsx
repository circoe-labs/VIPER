import { useState } from 'react'
import { useWarehouseWrites, type WarehouseImportResult } from '../api/warehouses'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TextField } from '../ui/fields'
import { warehouseError } from './WarehouseEditor'

export function WarehouseImport({ onClose, onImported }: { onClose: () => void; onImported: (result: WarehouseImportResult) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { preview, importFile } = useWarehouseWrites()
  const busy = preview.isPending || importFile.isPending
  return <Modal open title="Importer des entrepôts" onClose={() => { if (!busy) onClose() }} size="lg">
    <div className="warehouse-form">
      <p className="warehouse-muted">Classeur avec les colonnes « Nom entrepôt », propriétaire et « Prospect a contacter ». Les contacts d’un même site sont regroupés.</p>
      <TextField label="Fichier Excel" type="file" accept=".xlsx" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); preview.reset(); setError(null) }} />
      <Button disabled={!file || busy} loading={preview.isPending} onClick={() => {
        if (file) { setError(null); void preview.mutateAsync(file).catch((caught: unknown) => { setError(warehouseError(caught)) }) }
      }}>Vérifier le fichier</Button>
      {preview.data && <div className="warehouse-import-preview">
        <p><strong>{preview.data.warehouses} entrepôts</strong> et <strong>{preview.data.contacts} interlocuteurs</strong> identifiés.</p>
        {preview.data.existing > 0 && <p>{preview.data.existing} entrepôts déjà présents seront conservés sans modification.</p>}
        <ul>{preview.data.items.map((item, index) => <li key={index}>{item.name} <span className="warehouse-muted">· {item.contacts.length} interlocuteur{item.contacts.length > 1 ? 's' : ''}</span></li>)}</ul>
        <p className="warehouse-muted">Les coordonnées importées restent à vérifier. Les fiches de prospection existantes sont conservées.</p>
        <Button variant="primary" loading={importFile.isPending} disabled={busy} onClick={() => {
          if (file) { setError(null); void importFile.mutateAsync(file).then(onImported).catch((caught: unknown) => { setError(warehouseError(caught)) }) }
        }}>Importer les entrepôts</Button>
      </div>}
      {error && <p className="warehouse-error" role="alert">{error}</p>}
    </div>
  </Modal>
}
