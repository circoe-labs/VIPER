import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { useMission, useMissionOverview, useSetMissionStatus } from '../api/missions'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { type TabItem, Tabs } from '../ui/Tabs'
import {
  AlertIcon,
  ArrowLeftIcon,
  PauseIcon,
  SparklesIcon,
} from '../ui/icons'
import { CreateMissionDialog } from './CreateMissionDialog'
import { DeleteMissionDialog } from './DeleteMissionDialog'
import { MISSION_TAB_LABELS, MISSION_TABS, type MissionTabId, parseMissionTab } from './labels'
import { ActivityTab } from './ActivityTab'
import { MissionHeader } from './MissionHeader'
import { MissionLiveStrip } from './MissionLiveStrip'
import { MissionOverviewTab } from './MissionOverviewTab'
import { missingForRun } from './missionKinds'
import { ResultsTab } from './ResultsTab'
import { StatsTab } from './StatsTab'
import './missions.css'
import './missionDetail.css'

// Live strip refresh; the polling pauses by itself while the browser tab is hidden.
const OVERVIEW_POLL_MS = 15_000

export function MissionDetailPage() {
  const { missionId } = useParams()
  const mission = useMission(missionId)
  const setStatus = useSetMissionStatus(missionId ?? '')
  const navigate = useNavigate()
  // Polled only while the page is visible (react-query does not refetch in a background tab).
  const overview = useMissionOverview(missionId, OVERVIEW_POLL_MS)
  const [params, setParams] = useSearchParams()
  const tab = parseMissionTab(params.get('tab'))
  function selectTab(id: MissionTabId) {
    setParams(id === 'overview' ? {} : { tab: id }, { replace: true })
  }
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  if (mission.isLoading) {
    return <p className="missions-muted">Chargement…</p>
  }
  if (mission.isError || !mission.data) {
    return (
      <EmptyState
        icon={SparklesIcon}
        title="Mission introuvable"
        description="Elle a peut-être été supprimée."
        action={
          <Link to="/missions">
            <Button variant="secondary" icon={ArrowLeftIcon}>
              Retour aux missions
            </Button>
          </Link>
        }
      />
    )
  }

  const { card, targets, runs, result_kind } = mission.data
  const pending = overview.data?.pending_reviews ?? card.results_pending
  const tabs: TabItem<MissionTabId>[] = MISSION_TABS.map((id) => ({
    id,
    label: MISSION_TAB_LABELS[id],
    extra:
      id === 'results' && pending > 0 ? (
        <span className="mission-tab-count">
          {String(pending)}
          <span className="visually-hidden"> à relire</span>
        </span>
      ) : undefined,
  }))
  const open = card.status === 'active'
  // Same rule as the server: a rule that would create no task is flagged.
  const missing = missingForRun(card.type, result_kind, targets)
  const lastRun = runs[0]

  return (
    <div className="missions">
      <Link to="/missions" className="missions-back">
        <ArrowLeftIcon size={16} /> Missions
      </Link>
      <MissionHeader
        mission={mission.data}
        statusPending={setStatus.isPending}
        onToggleStatus={() => {
          setStatus.mutate(open ? 'paused' : 'active')
        }}
        onEdit={() => {
          setEditing(true)
        }}
        onDelete={() => {
          setDeleting(true)
        }}
      />
      {setStatus.isError && <p className="missions-error">Le statut n’a pas pu être changé.</p>}
      {editing && (
        <CreateMissionDialog
          open
          mission={mission.data}
          onClose={() => {
            setEditing(false)
          }}
        />
      )}
      <DeleteMissionDialog
        open={deleting}
        missionId={card.id}
        name={card.name}
        onClose={() => {
          setDeleting(false)
        }}
        onDeleted={() => {
          void navigate('/missions')
        }}
      />
      {card.status === 'paused' && (
        <p className="missions-banner" role="status">
          <PauseIcon size={18} />
          Inactive : ses tâches ne sont plus proposées aux agents. « Activer » les leur rouvre.
        </p>
      )}
      {card.status === 'active' && missing && (
        <p className="missions-banner missions-banner--danger" role="alert">
          <AlertIcon size={18} />
          Cette mission ne peut pas s’exécuter : {missing} Utilisez « Modifier ».
        </p>
      )}
      {lastRun?.status === 'failed' && lastRun.note && (
        <p className="missions-banner missions-banner--danger" role="alert">
          <AlertIcon size={18} />
          Dernière exécution en échec : {lastRun.note}
        </p>
      )}
      <MissionLiveStrip
        overview={overview}
        onOpenResults={() => {
          selectTab('results')
        }}
      />

      <Tabs label="Sections de la mission" tabs={tabs} selected={tab} onSelect={selectTab}>
        {tab === 'overview' && <MissionOverviewTab mission={mission.data} />}
        {tab === 'activity' && <ActivityTab missionId={card.id} />}
        {tab === 'results' && <ResultsTab missionId={card.id} />}
        {tab === 'stats' && <StatsTab missionId={card.id} />}
      </Tabs>
    </div>
  )
}
