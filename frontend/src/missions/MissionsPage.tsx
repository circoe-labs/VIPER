import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { type MissionCard, useMission, useMissionProposals, useMissions } from '../api/missions'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import type { Point } from '../ui/floating'
import { PencilIcon, PlusIcon, SparklesIcon, TrashIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { Menu } from '../ui/Menu'
import { CreateMissionDialog } from './CreateMissionDialog'
import { DeleteMissionDialog } from './DeleteMissionDialog'
import { VoiceAssistantEntry } from './voice/VoiceAssistantEntry'
import { MissionCardTile, type OpenMenu } from './MissionCardTile'
import { MissionsKpiBar } from './MissionsKpiBar'
import { DEFAULT_FILTERS, filterMissions, isFiltered, type ListFilters, sortMissions } from './missionsListModel'
import { MissionsToolbar } from './MissionsToolbar'
import './missions.css'
import './missionsList.css'

// « Modifier… » from the list: the form needs the whole rule, read first.
function EditMission({ id, onClose }: { id: string; onClose: () => void }) {
  const mission = useMission(id)
  if (mission.isError) {
    return (
      <p className="missions-error" role="alert">
        La mission n’a pas pu être chargée pour la modifier.
      </p>
    )
  }
  if (!mission.data) return null
  return <CreateMissionDialog open mission={mission.data} onClose={onClose} />
}

// Refresh of the agents working on each card; the polling pauses by itself while the browser tab is hidden.
const LIST_POLL_MS = 15_000

export function MissionsPage() {
  const [filters, setFilters] = useState<ListFilters>(DEFAULT_FILTERS)
  const [creating, setCreating] = useState(false)
  // One unfiltered query: the counters read all of it, the cards read the filtered and sorted view of it.
  const missions = useMissions(undefined, LIST_POLL_MS)
  const proposals = useMissionProposals()
  const [menu, setMenu] = useState<{ card: MissionCard; position: Point; alignRight: boolean } | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<MissionCard | null>(null)
  const navigate = useNavigate()
  const all = missions.data?.items
  const cards = useMemo(() => sortMissions(filterMissions(all ?? [], filters), filters.sort), [all, filters])
  const openMenu: OpenMenu = (card, position, alignRight) => {
    setMenu({ card, position, alignRight })
  }
  const newMission = (
    <Button
      variant="primary"
      icon={PlusIcon}
      onClick={() => {
        setCreating(true)
      }}
    >
      Nouvelle mission
    </Button>
  )

  return (
    <div className="missions">
      <PageHeader mascot="mission"
        title="Missions"
        description={
          <span className="missions-detail__meta">
            Pilotez et suivez l’exécution de vos missions par les agents.
            <InfoTip label="Aide : missions">
              Une mission = une consigne, des données VIPER, une exécution. Chaque exécution crée des tâches que les agents
              connectés (Claude, ChatGPT…) prennent ; leurs propositions attendent votre relecture, rien n’est écrit sans
              votre validation.
            </InfoTip>
          </span>
        }
        actions={newMission}
      />
      <MissionsKpiBar
        items={missions.isError ? null : all}
        proposals={proposals.isError ? null : proposals.data?.length}
      />
      {(all?.length ?? 0) > 0 && <MissionsToolbar filters={filters} onChange={setFilters} />}
      {missions.isLoading && (
        <section aria-busy="true" aria-label="Chargement des missions">
          <p className="missions-muted" role="status">
            Chargement des missions…
          </p>
          <ul className="mlist-grid" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <li key={index} className="mui-skeleton mlist-skeleton" />
            ))}
          </ul>
        </section>
      )}
      {missions.isError && (
        <p className="mui-state" role="alert">
          Les missions n’ont pas pu être chargées.{' '}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void missions.refetch()
            }}
          >
            Réessayer
          </Button>
        </p>
      )}
      {missions.isSuccess && all?.length === 0 && (
        <EmptyState
          icon={SparklesIcon}
          title="Aucune mission"
          description="Créez une mission : une consigne, des fiches liées, et les agents travaillent pendant que vous relisez les résultats."
          action={newMission}
        />
      )}
      {missions.isSuccess && (all?.length ?? 0) > 0 && cards.length === 0 && (
        <p className="mui-state" role="status">
          Aucune mission ne correspond à ces filtres.{' '}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })
            }}
          >
            Réinitialiser les filtres
          </Button>
        </p>
      )}
      {cards.length > 0 && (
        <ul className="mlist-grid" aria-label={isFiltered(filters) ? 'Missions filtrées' : 'Missions'}>
          {cards.map((card) => (
            <li key={card.id}>
              <MissionCardTile card={card} onMenu={openMenu} />
            </li>
          ))}
        </ul>
      )}
      <CreateMissionDialog
        open={creating}
        assistantSlot={(form, { submit }) => <VoiceAssistantEntry form={form} submit={submit} />}
        onClose={() => {
          setCreating(false)
        }}
      />
      {menu && (
        <Menu
          label={`Actions de la mission ${menu.card.name}`}
          position={menu.position}
          alignRight={menu.alignRight}
          onClose={() => {
            setMenu(null)
          }}
          sections={[
            {
              items: [
                {
                  id: 'open',
                  label: 'Ouvrir',
                  onSelect: () => {
                    void navigate(`/missions/${menu.card.id}`)
                  },
                },
                {
                  id: 'edit',
                  label: 'Modifier…',
                  icon: PencilIcon,
                  disabled: menu.card.status === 'done' || menu.card.status === 'cancelled',
                  title:
                    menu.card.status === 'done' || menu.card.status === 'cancelled'
                      ? 'Mission terminée : créez-en une nouvelle.'
                      : undefined,
                  onSelect: () => {
                    setEditId(menu.card.id)
                  },
                },
              ],
            },
            {
              items: [
                {
                  id: 'delete',
                  label: 'Supprimer…',
                  icon: TrashIcon,
                  danger: true,
                  onSelect: () => {
                    setDeleting(menu.card)
                  },
                },
              ],
            },
          ]}
        />
      )}
      {editId && (
        <EditMission
          key={editId}
          id={editId}
          onClose={() => {
            setEditId(null)
          }}
        />
      )}
      {deleting && (
        <DeleteMissionDialog
          key={deleting.id}
          open
          missionId={deleting.id}
          name={deleting.name}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}
