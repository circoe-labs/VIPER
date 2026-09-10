// Development-only catalogue of the design-system primitives (route /_dev/ui, excluded from production builds).
// Content is generic placeholder text: no business data.
import { useRef, useState } from 'react'

import { BrandLogo } from '../brand/BrandLogo'
import type { LogoVariant } from '../brand/logos'
import { Badge, StatusBadge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { Drawer, Modal } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Checkbox, SelectField, Switch, TextAreaField, TextField } from '../ui/fields'
import * as icons from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { Table } from '../ui/Table'
import './showcase.css'

const SWATCHES = [
  'canvas',
  'surface',
  'surface-raised',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'accent',
  'accent-fg',
  'accent-soft',
  'accent-2',
  'focus',
  'warning-fg',
  'danger',
  'success-fg',
  'info-fg',
]

const LOGO_VARIANTS: LogoVariant[] = ['mark', 'lockup', 'accent']

const ROWS = [1, 2, 3, 4].map((n) => ({ id: n, name: `Élément ${String(n)}`, updated: `0${String(n)}/01/2000` }))

export function Showcase() {
  const [modalOpen, setModalOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <PageHeader
        title="Composants"
        description="Catalogue de développement du design system Neon Command. Absent des builds de production."
        actions={
          <Button variant="primary" icon={icons.PlusIcon}>
            Action principale
          </Button>
        }
      />
      <div className="showcase">
        <Card title="Marque">
          <div className="showcase__row showcase__row--logos">
            {LOGO_VARIANTS.map((variant) => (
              <figure key={variant} className="showcase__logo">
                <BrandLogo variant={variant} height="4rem" />
                <figcaption className="eyebrow">{variant}</figcaption>
              </figure>
            ))}
          </div>
        </Card>

        <Card title="Couleurs sémantiques">
          <div className="showcase__swatches">
            {SWATCHES.map((name) => (
              <div key={name} className="showcase__swatch">
                <span style={{ background: `var(--color-${name})` }} />
                <code>--color-{name}</code>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Boutons">
          <div className="showcase__row">
            <Button variant="primary">Enregistrer</Button>
            <Button>Annuler</Button>
            <Button variant="ghost">Plus tard</Button>
            <Button variant="danger">Supprimer</Button>
            <Button variant="primary" loading>
              Enregistrement
            </Button>
            <Button disabled>Indisponible</Button>
          </div>
          <div className="showcase__row">
            <Button variant="primary" size="sm" icon={icons.PlusIcon}>
              Ajouter
            </Button>
            <Button size="sm">Secondaire</Button>
            <IconButton icon={icons.CloseIcon} label="Fermer" />
            <IconButton icon={icons.PanelLeftIcon} label="Panneau" variant="secondary" />
            <IconButton icon={icons.SunIcon} label="Thème" size="sm" />
          </div>
        </Card>

        <Card title="Statuts">
          <div className="showcase__row">
            <StatusBadge tone="success">Vérifié</StatusBadge>
            <StatusBadge tone="warning">Non vérifié</StatusBadge>
            <StatusBadge tone="warning" icon={icons.ClockIcon}>
              À revérifier
            </StatusBadge>
            <StatusBadge tone="danger">Ne pas contacter</StatusBadge>
            <StatusBadge tone="info">Information</StatusBadge>
            <StatusBadge tone="neutral">Inconnu</StatusBadge>
            <Badge>Étiquette</Badge>
            <Badge tone="accent">12</Badge>
          </div>
        </Card>

        <Card title="Champs">
          <div className="showcase__grid">
            <TextField label="Nom" placeholder="Texte" hint="Aide contextuelle." required />
            <TextField label="Adresse e-mail" defaultValue="invalide" error="Adresse e-mail invalide." />
            <SelectField label="Choix" defaultValue="a">
              <option value="a">Option A</option>
              <option value="b">Option B</option>
            </SelectField>
            <TextAreaField label="Note" placeholder="Texte libre" />
            <Checkbox label="Case à cocher" defaultChecked />
            <Switch label="Interrupteur" hint="S’applique immédiatement." defaultChecked />
          </div>
        </Card>

        <Card title="Tableaux">
          <Table caption="Tableau confortable">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Statut</th>
                <th className="table__numeric">Mise à jour</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>
                    <StatusBadge tone={row.id % 2 ? 'success' : 'warning'}>
                      {row.id % 2 ? 'Vérifié' : 'Non vérifié'}
                    </StatusBadge>
                  </td>
                  <td className="table__numeric">{row.updated}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table caption="Tableau compact" density="compact">
            <thead>
              <tr>
                <th className="table__numeric">id</th>
                <th>name</th>
                <th>updated_at</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.id}>
                  <td className="table__numeric">{row.id}</td>
                  <td>{row.name}</td>
                  <td>{row.updated}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Superpositions">
          <div className="showcase__row">
            <Button
              onClick={() => {
                setModalOpen(true)
              }}
            >
              Ouvrir une modale
            </Button>
            <Button
              onClick={() => {
                setDrawerOpen(true)
              }}
            >
              Ouvrir un panneau
            </Button>
          </div>
          <EmptyState
            icon={icons.DatabaseIcon}
            title="Aucun élément"
            description="Explique pourquoi la liste est vide et propose l’action suivante."
            action={<Button icon={icons.PlusIcon}>Créer</Button>}
          />
        </Card>

        <Card title="Icônes">
          <div className="showcase__row">
            {Object.entries(icons)
              .filter(([name]) => name.endsWith('Icon'))
              .map(([name, Icon]) => (
                <span key={name} className="showcase__icon" title={name}>
                  <Icon size={24} />
                </span>
              ))}
          </div>
        </Card>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false)
        }}
        title="Confirmer la suppression"
        description="Cette action est définitive."
        size="sm"
        footer={
          <>
            <Button
              onClick={() => {
                setModalOpen(false)
              }}
            >
              Annuler
            </Button>
            <Button variant="danger">Supprimer</Button>
          </>
        }
      >
        <p>Contenu de la modale.</p>
      </Modal>

      <Drawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false)
        }}
        title="Éditeur"
        description="Panneau latéral large qui conserve la liste en arrière-plan."
        initialFocusRef={firstFieldRef}
        footer={
          <>
            <Button
              onClick={() => {
                setDrawerOpen(false)
              }}
            >
              Annuler
            </Button>
            <Button variant="primary">Enregistrer</Button>
          </>
        }
      >
        <div className="showcase__grid">
          <TextField ref={firstFieldRef} label="Champ" />
          <TextField label="Autre champ" hint="Aide." />
        </div>
      </Drawer>
    </>
  )
}
