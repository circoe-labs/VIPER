import { useState } from "react";

import {
  type StatsBucket,
  useMissionOverview,
  useMissionStatistics,
} from "../api/missions";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { InfoIcon, RefreshIcon } from "../ui/icons";
import {
  ActivityAnalysisPanel,
  ActivityChartPanel,
  AttentionPanel,
  EventBreakdownPanel,
  ResultsSeriesPanel,
  SessionsSeriesPanel,
} from "./StatsActivityPanel";
import { AgentDonutPanel, AgentTablePanel } from "./StatsAgentPanels";
import { StatsKpiStrip } from "./StatsKpiStrip";
import { StatsProgressPanel } from "./StatsProgressPanel";
import { StatsResultsPanel, StatsTasksPanel } from "./StatsResultsPanel";
import {
  allowedDays,
  BUCKET_LABELS,
  DEFAULT_BUCKET,
  DEFAULT_DAYS,
  HOURLY_MAX_DAYS,
  hasNoHistory,
  RANGE_DAYS,
} from "./statsModel";
import "./stats.css";

interface TabProps {
  missionId: string;
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

// Statistiques tab (Slice 09, redesigned in UI-redesign Slice 03). Progress and task KPIs come from the shared
// overview query; everything else from `GET /missions/{id}/statistics` (selectors in statsSelectors.ts). The toggles
// only change the window and bucket size of the time series, totals and distributions always cover the whole mission.
export function StatsTab({ missionId }: TabProps) {
  const [bucket, setBucket] = useState<StatsBucket>(DEFAULT_BUCKET);
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const query = useMissionStatistics(missionId, { bucket, days });
  const stats = query.data;
  const overview = useMissionOverview(missionId);

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

      <div className="stp-top">
        <StatsProgressPanel overview={overview} />
        <StatsKpiStrip overview={overview} />
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
          {query.isPlaceholderData && (
            <p className="stats-muted" role="status">
              Mise à jour des chiffres…
            </p>
          )}
          {query.isError && (
            <p className="stats-muted" role="status">
              Actualisation impossible : les chiffres affichés peuvent être
              périmés.
            </p>
          )}
          <div className="stp-layout">
            <p className="stats-muted">
              Évolution sur {String(stats.days)} jours (
              {BUCKET_LABELS[stats.bucket].toLowerCase()}, UTC). Les totaux,
              répartitions et le tableau par agent couvrent toute la mission.
            </p>
            <ActivityChartPanel stats={stats} />
            <div className="stp-row-3">
              <AgentDonutPanel stats={stats} />
              <StatsResultsPanel stats={stats} />
              <StatsTasksPanel stats={stats} />
            </div>
            <div className="stp-row-3">
              <ActivityAnalysisPanel stats={stats} />
              <AttentionPanel stats={stats} />
              <EventBreakdownPanel stats={stats} />
            </div>
            <div className="stp-row-2">
              <ResultsSeriesPanel stats={stats} />
              <SessionsSeriesPanel stats={stats} />
            </div>
            <AgentTablePanel stats={stats} />
          </div>
        </>
      )}
    </div>
  );
}
