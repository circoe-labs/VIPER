import { useRef, useState } from 'react'

import { ApiError } from '../api/client'
import { type MissionSource, useAddMissionSource, useMissionSources } from '../api/missions'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { Checkbox, TextField } from '../ui/fields'
import { PlusIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'
import './configPickers.css'
import { addableTree, addressProblem, findByAddress, refusalMessage, type SourceRef, toRef } from './sourcesDraft'
import { sourceName } from './sourceTree'

interface LibraryState {
  rows: readonly MissionSource[]
  loading: boolean
  failed: boolean
}

// « Ajouter depuis la bibliothèque »: the saved sources the mission does not have yet, searchable, sub-sources nested
// under their site. Several can be ticked, then added at once.
function LibraryPickerDialog({
  library,
  taken,
  onAdd,
  onClose,
}: {
  library: LibraryState
  taken: ReadonlySet<string>
  onAdd: (sources: SourceRef[]) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const tree = addableTree(library.rows, taken, query)
  const toggle = (id: string) => {
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const row = (source: MissionSource) => (
    <Checkbox
      label={sourceName(source)}
      hint={source.label ? <span className="cfg-source__url">{source.url}</span> : undefined}
      checked={ticked.has(source.id)}
      onChange={() => {
        toggle(source.id)
      }}
    />
  )
  const add = () => {
    onAdd(library.rows.filter((source) => ticked.has(source.id)).map(toRef))
    onClose()
  }
  return (
    <Modal
      open
      size="md"
      title="Ajouter depuis la bibliothèque"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" icon={PlusIcon} disabled={ticked.size === 0} onClick={add}>
            {ticked.size > 0 ? `Ajouter (${String(ticked.size)})` : 'Ajouter'}
          </Button>
        </>
      }
    >
      <div className="msrc-picker">
        <SearchField label="Rechercher une source" value={query} onChange={setQuery} />
        {library.loading ? (
          <p className="cfg-empty">Chargement des sources…</p>
        ) : library.failed ? (
          <p className="missions-error" role="alert">
            La bibliothèque de sources n’a pas pu être chargée.
          </p>
        ) : tree.length === 0 ? (
          <p className="cfg-empty">
            {query.trim() ? 'Aucune source ne correspond.' : 'Toutes les sources de la bibliothèque sont déjà ajoutées.'}
          </p>
        ) : (
          <ul className="cfg-list msrc-picker__list" aria-label="Sources de la bibliothèque">
            {tree.map(({ source, children }) => (
              <li key={source.id}>
                {taken.has(source.id) ? (
                  <p className="msrc-picker__site">{sourceName(source)}</p>
                ) : (
                  row(source)
                )}
                {children.length > 0 && (
                  <ul className="cfg-list cfg-list--nested" aria-label={`Sous-sources de ${sourceName(source)}`}>
                    {children.map((child) => (
                      <li key={child.id}>{row(child)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

// « Ajouter manuellement »: a link typed by hand. It is saved in the library (once per address: an address already
// known is reused, not duplicated), then added to the mission's list.
function ManualSourceDialog({
  current,
  library,
  onAdd,
  onClose,
}: {
  current: readonly SourceRef[]
  library: readonly MissionSource[]
  onAdd: (source: SourceRef) => void
  onClose: () => void
}) {
  const save = useAddMissionSource()
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const urlRef = useRef<HTMLInputElement>(null)

  const finish = (source: SourceRef) => {
    if (current.some((item) => item.id === source.id)) {
      setProblem('Cette source est déjà dans la liste de la mission.')
      return
    }
    onAdd(toRef(source))
    onClose()
  }

  const submit = () => {
    const invalid = addressProblem(url)
    setProblem(invalid)
    if (invalid) {
      urlRef.current?.focus()
      return
    }
    save.mutate(
      { url: url.trim(), label: label.trim() || null },
      {
        onSuccess: finish,
        onError: (error) => {
          // The address is already in the library (unique per organisation): reuse that source.
          const known = error instanceof ApiError && error.status === 409 ? findByAddress(library, url) : undefined
          if (known) finish(known)
        },
      },
    )
  }

  const known = save.error instanceof ApiError && save.error.status === 409 && findByAddress(library, url)
  const serverError =
    save.isError && !known
      ? refusalMessage(save.error, 'Le lien n’a pas pu être enregistré.')
      : null

  return (
    <Modal
      open
      size="md"
      title="Ajouter manuellement"
      initialFocusRef={urlRef}
      onClose={onClose}
      footer={
        <>
          <Button disabled={save.isPending} onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={PlusIcon} loading={save.isPending} onClick={submit}>
            Ajouter
          </Button>
        </>
      }
    >
      <form
        className="msrc-manual"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <TextField
          ref={urlRef}
          label="Adresse du site"
          type="url"
          required
          value={url}
          placeholder="https://…"
          error={problem}
          onChange={(event) => {
            setUrl(event.target.value)
            setProblem(null)
            save.reset()
          }}
        />
        <TextField
          label="Nom (facultatif)"
          value={label}
          placeholder="Annuaire des transporteurs"
          onChange={(event) => {
            setLabel(event.target.value)
          }}
        />
        {serverError && (
          <p className="missions-error" role="alert">
            {serverError}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

// The library is only fetched once a dialog that needs it opens.
export function LibraryPicker(props: { taken: ReadonlySet<string>; onAdd: (sources: SourceRef[]) => void; onClose: () => void }) {
  const library = useMissionSources()
  return (
    <LibraryPickerDialog
      {...props}
      library={{ rows: library.data ?? [], loading: library.isPending, failed: library.isError }}
    />
  )
}

export function ManualSourcePicker(props: { current: readonly SourceRef[]; onAdd: (source: SourceRef) => void; onClose: () => void }) {
  const library = useMissionSources()
  return <ManualSourceDialog {...props} library={library.data ?? []} />
}
