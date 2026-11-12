import { type ReactNode, useState } from "react";

import { TASK_STATUS_LABELS } from "../agents/labels";
import {
  ACTIVITY_EVENT_TYPES,
  type MissionStatistics,
  type StatsBucket,
  useMissionStatistics,
} from "../api/missions";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { InfoIcon, RefreshIcon } from "../ui/icons";
import { Table } from "../ui/Table";
import { StatsChart } from "./StatsChart";
import {
  agentAcceptanceRate,
  allowedDays,
  BUCKET_LABELS,
  countPoints,
  DEFAULT_BUCKET,
  DEFAULT_DAYS,
  EVENT_TYPE_LABELS,
  formatCount,
  formatDuration,
  formatRate,
  HOURLY_MAX_DAYS,
  hasNoHistory,
  RANGE_DAYS,
  RESULT_SERIES,
  RESULT_STATUS_LABELS,
  resultPoints,
  sumValues,
} from "./statsModel";
import "./stats.css";

interface TabProps {
  missionId: string;
}

interface KpiProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "success" | "danger" | "warning";
  zero?: boolean;
}

function Kpi({ label, value, hint, tone, zero }: KpiProps) {
  const classes = [
    "stats-kpi",
    tone && `stats-kpi--${tone}`,
    zero && "stats-kpi--zero",
  ];
  return (
    <div className={classes.filter(Boolean).join(" ")}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint && <p className="stats-kpi__hint">{hint}</p>}
    </div>
  );
}

function count(label: string, value: number, tone?: KpiProps["tone"]) {
  return (
    <Kpi
      key={label}
      label={label}
      value={formatCount(value)}
      tone={tone}
      zero={value === 0}
    />
  );
}

function KpiGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="stats-group" aria-labelledby={`stats-${id}`}>
      <h3 id={`stats-${id}`} className="eyebrow">
        {title}
      </h3>
      <dl className="stats-kpis">{children}</dl>
    </section>
  );
}

function Kpis({ stats }: { stats: MissionStatistics }) {
  const {
    results_by_status: results,
    tasks_by_status: tasks,
    sessions_by_status: sessions,
  } = stats;
  return (
    <div className="stats-kpi-groups">
      <KpiGroup id="results" title="Résultats (toute la mission)">
        {count(
          RESULT_STATUS_LABELS.pending_review,
          results.pending_review,
          "warning",
        )}
        {count(RESULT_STATUS_LABELS.accepted, results.accepted, "success")}
        {count(RESULT_STATUS_LABELS.rejected, results.rejected, "danger")}
        {count(RESULT_STATUS_LABELS.superseded, results.superseded)}
        <Kpi
          label="Taux d’acceptation"
          value={formatRate(stats.acceptance_rate)}
          hint={
            stats.acceptance_rate === null
              ? "Aucun résultat décidé pour l’instant."
              : `Sur ${formatCount(results.accepted + results.rejected)} résultat(s) acceptés ou refusés.`
          }
        />
        <Kpi
          label="Délai moyen de relecture"
          value={formatDuration(stats.avg_review_seconds)}
          hint={
            stats.avg_review_seconds === null
              ? "Aucun résultat décidé pour l’instant."
              : "Du dépôt à la décision."
          }
        />
      </KpiGroup>
      <KpiGroup id="tasks" title="Tâches (toute la mission)">
        {(
          Object.keys(TASK_STATUS_LABELS) as (keyof typeof TASK_STATUS_LABELS)[]
        ).map((status) =>
          count(
            TASK_STATUS_LABELS[status],
            tasks[status],
            status === "failed" ? "danger" : undefined,
          ),
        )}
      </KpiGroup>
      <KpiGroup id="agents" title="Activité des agents (toute la mission)">
        <Kpi
          label="Sessions"
          value={formatCount(sumValues(sessions))}
          hint={`${formatCount(sessions.active)} active(s), ${formatCount(sessions.timed_out)} expirée(s).`}
          zero={sumValues(sessions) === 0}
        />
        <Kpi
          label="Journaux"
          value={formatCount(sumValues(stats.logs_by_event_type))}
          zero={sumValues(stats.logs_by_event_type) === 0}
        />
        {count("Sources ouvertes", stats.logs_by_event_type.source_opened)}
        {count("Erreurs signalées", stats.logs_by_event_type.error, "danger")}
      </KpiGroup>
    </div>
  );
}

function EventBreakdown({ stats }: { stats: MissionStatistics }) {
  const values = stats.logs_by_event_type;
  const peak = Math.max(1, ...ACTIVITY_EVENT_TYPES.map((type) => values[type]));
  return (
    <section className="stats-block" aria-labelledby="stats-events">
      <h3 id="stats-events" className="stats-block__title">
        Journaux par type d’événement
      </h3>
      <ul className="stats-events">
        {ACTIVITY_EVENT_TYPES.map((type) => (
          <li key={type} className="stats-events__row">
            <span className="stats-events__label">
              {EVENT_TYPE_LABELS[type]}
            </span>
            <span className="stats-events__bar" aria-hidden="true">
              <i style={{ width: `${String((values[type] / peak) * 100)}%` }} />
            </span>
            <span className="stats-events__count">
              {formatCount(values[type])}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AgentTable({ stats }: { stats: MissionStatistics }) {
  return (
    <section className="stats-block" aria-labelledby="stats-agents-table">
      <h3 id="stats-agents-table" className="stats-block__title">
        Par agent
      </h3>
      {stats.agents.length === 0 ? (
        <p className="stats-muted">
          Aucun agent n’a encore travaillé sur cette mission.
        </p>
      ) : (
        <Table
          caption="Statistiques par agent (toute la mission)"
          density="compact"
        >
          <thead>
            <tr>
              <th scope="col">Agent</th>
              {[
                "Sessions",
                "Journaux",
                "Résultats",
                "Acceptés",
                "Refusés",
                "À relire",
                "Taux d’acceptation",
              ].map((head) => (
                <th scope="col" key={head} className="stats-num">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.agents.map((agent) => (
              <tr key={agent.agent_id}>
                <th scope="row">{agent.agent_label}</th>
                <td className="stats-num">{formatCount(agent.sessions)}</td>
                <td className="stats-num">{formatCount(agent.logs)}</td>
                <td className="stats-num">{formatCount(agent.results)}</td>
                <td className="stats-num">{formatCount(agent.accepted)}</td>
                <td className="stats-num">{formatCount(agent.rejected)}</td>
                <td className="stats-num">
                  {formatCount(agent.pending_review)}
                </td>
                <td className="stats-num">
                  {formatRate(agentAcceptanceRate(agent))}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  format: (option: T) => string;
  disabled?: (option: T) => boolean;
}) {
  return (
    <div className="stats-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option}
          size="sm"
          variant={option === value ? "primary" : "secondary"}
          aria-pressed={option === value}
          disabled={disabled?.(option)}
          onClick={() => {
            onChange(option);
          }}
        >
          {format(option)}
        </Button>
      ))}
    </div>
  );
}

// Statistiques tab (Slice 09). Server-aggregated figures from `GET /missions/{id}/statistics`; the toggles only
// change the window and bucket size of the three time series, the KPI totals always cover the whole mission.
export function StatsTab({ missionId }: TabProps) {
  const [bucket, setBucket] = useState<StatsBucket>(DEFAULT_BUCKET);
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const query = useMissionStatistics(missionId, { bucket, days });
  const stats = query.data;

  function changeBucket(next: StatsBucket) {
    setBucket(next);
    if (next === "hour")
      setDays((current) => Math.min(current, HOURLY_MAX_DAYS));
  }

  return (
    <div className="stats-tab" data-mission-id={missionId}>
      <div className="stats-controls">
        <Segmented
          label="Taille des périodes"
          options={["day", "hour"] as const}
          value={bucket}
          onChange={changeBucket}
          format={(b) => BUCKET_LABELS[b]}
        />
        <Segmented
          label="Fenêtre"
          options={RANGE_DAYS}
          value={days}
          onChange={setDays}
          format={(d) => `${String(d)} jours`}
          disabled={(d) =>
            !allowedDays(bucket).includes(d as (typeof RANGE_DAYS)[number])
          }
        />
        <p className="stats-muted">
          Les périodes suivent les bornes UTC, qui peuvent différer de votre
          jour local.
          {bucket === "hour" &&
            ` Le détail horaire est limité à ${String(HOURLY_MAX_DAYS)} jours.`}
        </p>
      </div>

      {!stats && query.isError && (
        <div className="stats-state" role="alert">
          <p>Les statistiques sont indisponibles.</p>
          <Button
            size="sm"
            icon={RefreshIcon}
            loading={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
      {!stats && !query.isError && (
        <p className="stats-state" role="status">
          Chargement des statistiques…
        </p>
      )}

      {stats && hasNoHistory(stats) && (
        <EmptyState
          icon={InfoIcon}
          title="Aucune statistique pour l’instant"
          description="Les chiffres apparaîtront dès qu’un agent aura travaillé sur cette mission : sessions, journaux et résultats."
        />
      )}

      {stats && !hasNoHistory(stats) && (
        <>
          {query.isError && (
            <p className="stats-muted" role="status">
              Actualisation impossible : les chiffres affichés peuvent être
              périmés.
            </p>
          )}
          <Kpis stats={stats} />
          <section className="stats-block" aria-labelledby="stats-series">
            <h3 id="stats-series" className="stats-block__title">
              Évolution sur {String(stats.days)} jours (
              {BUCKET_LABELS[stats.bucket].toLowerCase()}, UTC)
            </h3>
            <div className="stats-charts">
              <StatsChart
                id="stats-results"
                title="Résultats déposés"
                series={RESULT_SERIES}
                points={resultPoints(stats)}
                bucket={stats.bucket}
              />
              <StatsChart
                id="stats-logs"
                title="Journaux des agents"
                series={[{ key: "count", label: "Journaux", tone: "info" }]}
                points={countPoints(stats.logs_series)}
                bucket={stats.bucket}
              />
              <StatsChart
                id="stats-sessions"
                title="Sessions démarrées"
                series={[{ key: "count", label: "Sessions", tone: "accent" }]}
                points={countPoints(stats.sessions_series)}
                bucket={stats.bucket}
              />
            </div>
          </section>
          <div className="stats-split">
            <AgentTable stats={stats} />
            <EventBreakdown stats={stats} />
          </div>
        </>
      )}
    </div>
  );
}
