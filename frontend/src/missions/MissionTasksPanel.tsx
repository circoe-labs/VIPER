import { useState } from 'react'

import { taskBadge, TASK_TYPE_LABELS } from '../agents/labels'
import type { MissionTaskRow } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { BoltIcon, ChevronLeftIcon, ChevronRightIcon } from '../ui/icons'
import { MissionPanel } from './MissionPanel'
import './results.css'

const PAGE_SIZE = 20

// The tasks of the mission, usable with 500 of them: a count per outcome (each one a filter) and pages. Tasks waiting
// for a review come first.
export function MissionTasksPanel({ tasks, onReview }: { tasks: MissionTaskRow[]; onReview: (resultId: string) => void }) {
  const [filter, setFilter] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  const labelled = tasks.map((task) => ({ task, badge: taskBadge(task.status, task.failure_code) }))
  const counts = new Map<string, number>()
  for (const { badge } of labelled) counts.set(badge.label, (counts.get(badge.label) ?? 0) + 1)
  // A filter whose last task moved on falls back to « Toutes ».
  const active = filter !== null && counts.has(filter) ? filter : null
  const shown = labelled
    .filter(({ badge }) => active === null || badge.label === active)
    .sort((a, b) => Number(b.task.status === 'submitted') - Number(a.task.status === 'submitted'))
  const last = Math.max(0, Math.ceil(shown.length / PAGE_SIZE) - 1)
  const current = Math.min(page, last)
  const rows = shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const chips: [string | null, string, number][] = [
    [null, 'Toutes', tasks.length],
    ...[...counts].map(([label, count]): [string, string, number] => [label, label, count]),
  ]

  return (
    <MissionPanel title={`Tâches (${String(tasks.length)})`} icon={BoltIcon} hue="amber" level={2}>
      {tasks.length === 0 ? (
        <p className="missions-muted">Aucune tâche : lancez la mission pour en créer.</p>
      ) : (
        <>
          <div role="group" aria-label="Filtrer les tâches" className="results-status">
            {chips.map(([value, label, count]) => (
              <button
                key={label}
                type="button"
                className="results-status__chip"
                aria-pressed={active === value}
                onClick={() => {
                  setFilter(value)
                  setPage(0)
                }}
              >
                {label}
                <span className="results-status__count"> {String(count)}</span>
              </button>
            ))}
          </div>
          <ul className="mission-tasks" aria-label="Tâches de la mission">
            {rows.map(({ task, badge }) => {
              const subject = task.prospect_name ?? task.company_name
              return (
                <li key={task.id} className="mission-task">
                  <div className="mission-task__main">
                    <span className="mission-task__type">{TASK_TYPE_LABELS[task.type]}</span>
                    {subject && <span className="mission-task__target">{subject}</span>}
                  </div>
                  <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                  <span className="mission-task__meta">{task.claimed_by_label ?? (task.status === 'pending' ? 'libre' : '')}</span>
                  {task.result_id && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        if (task.result_id) onReview(task.result_id)
                      }}
                    >
                      Relire
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
          {shown.length > PAGE_SIZE && (
            <nav className="results-pager" aria-label="Pagination des tâches">
              <Button
                size="sm"
                icon={ChevronLeftIcon}
                disabled={current === 0}
                onClick={() => {
                  setPage(current - 1)
                }}
              >
                Précédentes
              </Button>
              <span aria-live="polite">
                {String(current * PAGE_SIZE + 1)}–{String(current * PAGE_SIZE + rows.length)} sur {String(shown.length)}
              </span>
              <Button
                size="sm"
                disabled={current === last}
                onClick={() => {
                  setPage(current + 1)
                }}
              >
                Suivantes
                <ChevronRightIcon size={16} />
              </Button>
            </nav>
          )}
        </>
      )}
    </MissionPanel>
  )
}
