import { type DragEvent, useId, useRef, useState } from 'react'

import { Button } from '../ui/Button'
import { SpinnerIcon, SpreadsheetIcon, UploadIcon } from '../ui/icons'

interface FileDropProps {
  busy: boolean
  fileName: string | null
  onFile: (file: File) => void
}

// Drop zone + file picker. The chosen file stays in the page's memory and is sent for analysis only.
export function FileDrop({ busy, fileName, onFile }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [over, setOver] = useState(false)

  function dropped(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setOver(false)
    const file = event.dataTransfer.files[0]
    if (file && !busy) onFile(file)
  }

  return (
    <section
      className="import-drop"
      data-over={over || undefined}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => {
        setOver(false)
      }}
      onDrop={dropped}
    >
      <span className="import-drop__icon">
        <UploadIcon size={28} />
      </span>
      {busy ? (
        <>
          <h2 id={titleId} className="import-drop__title">
            Analyse en cours
          </h2>
          <p className="import-drop__status" role="status">
            <SpinnerIcon size={18} className="btn__spinner" />
            Lecture de « {fileName} » : feuilles, colonnes, valeurs et doublons…
          </p>
        </>
      ) : (
        <>
          <h2 id={titleId} className="import-drop__title">
            Déposez votre fichier Excel ici
          </h2>
          <p className="import-drop__or">ou</p>
          <Button
            variant="primary"
            icon={SpreadsheetIcon}
            onClick={() => {
              inputRef.current?.click()
            }}
          >
            Choisir un fichier
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.csv,.tsv,.txt"
            className="visually-hidden"
            tabIndex={-1}
            aria-label="Fichier à importer"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) onFile(file)
            }}
          />
        </>
      )}
      <p className="import-drop__hint">
        Classeur Excel (.xlsx) ou fichier CSV, 10 Mo au plus. Le fichier reste sur votre poste : seules les données que
        vous confirmez sont enregistrées.
      </p>
    </section>
  )
}
