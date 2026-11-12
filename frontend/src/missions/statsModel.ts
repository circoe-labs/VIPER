import type {
  AgentStats,
  MissionStatistics,
  StatsBucket,
} from "../api/missions";
import { RESULT_STATUS_COUNT_LABELS } from "./vocabulary";

// Pure view-model helpers of the Statistiques tab: labels, formatting and series arithmetic. No React here so the
// transformations are unit-testable. Buckets are UTC (the API's boundaries); every label says so.

export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
// The API refuses hourly buckets over more than 7 days.
export const HOURLY_MAX_DAYS = 7;
export const DEFAULT_BUCKET: StatsBucket = "day";
export const DEFAULT_DAYS: RangeDays = 30;

export const BUCKET_LABELS: Record<StatsBucket, string> = {
  day: "Par jour",
  hour: "Par heure",
};

// Days selectable for a bucket size.
export function allowedDays(bucket: StatsBucket): readonly RangeDays[] {
  return bucket === "hour"
    ? RANGE_DAYS.filter((days) => days <= HOURLY_MAX_DAYS)
    : RANGE_DAYS;
}

const NUMBER = new Intl.NumberFormat("fr-FR");

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${String(Math.round(rate * 100))} %`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${String(total)} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${String(hours)} h ${String(minutes % 60).padStart(2, "0")}`;
  return `${String(Math.floor(hours / 24))} j ${String(hours % 24)} h`;
}

const SHORT_DAY = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
});
const LONG_DAY = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "UTC",
  dateStyle: "medium",
});

function hourOf(date: Date): string {
  return String(date.getUTCHours()).padStart(2, "0");
}

// Axis label: « 12/11 » or « 12/11 14 h » (UTC).
export function bucketShortLabel(bucket: string, size: StatsBucket): string {
  const date = new Date(bucket);
  const day = SHORT_DAY.format(date);
  return size === "hour" ? `${day} ${hourOf(date)} h` : day;
}

// Table / tooltip label: « 12 nov. 2026 » or « 12 nov. 2026, 14 h » (UTC).
export function bucketLongLabel(bucket: string, size: StatsBucket): string {
  const date = new Date(bucket);
  const day = LONG_DAY.format(date);
  return size === "hour" ? `${day}, ${hourOf(date)} h` : day;
}

export interface ChartSeries {
  key: string;
  label: string;
  // Token family of the colour (`--color-<tone>-fg`), mapped in stats.css.
  tone: "success" | "danger" | "warning" | "neutral" | "info" | "accent";
}

export interface ChartPoint {
  bucket: string;
  values: Record<string, number>;
}

export const RESULT_SERIES: ChartSeries[] = [
  { key: "accepted", label: RESULT_STATUS_COUNT_LABELS.accepted, tone: "success" },
  { key: "rejected", label: RESULT_STATUS_COUNT_LABELS.rejected, tone: "danger" },
  {
    key: "pending_review",
    label: RESULT_STATUS_COUNT_LABELS.pending_review,
    tone: "warning",
  },
  {
    key: "superseded",
    label: RESULT_STATUS_COUNT_LABELS.superseded,
    tone: "neutral",
  },
];

export function resultPoints(stats: MissionStatistics): ChartPoint[] {
  return stats.results_series.map((point) => ({
    bucket: point.bucket,
    values: {
      accepted: point.accepted,
      rejected: point.rejected,
      pending_review: point.pending_review,
      superseded: point.superseded,
    },
  }));
}

export function countPoints(
  series: { bucket: string; count: number }[],
): ChartPoint[] {
  return series.map((point) => ({
    bucket: point.bucket,
    values: { count: point.count },
  }));
}

export function pointTotal(point: ChartPoint): number {
  return Object.values(point.values).reduce((sum, value) => sum + value, 0);
}

// Y axis: 4 equal steps up to a rounded maximum (at least 4 so a quiet chart does not show fractions).
export function axisFor(points: ChartPoint[]): {
  step: number;
  maximum: number;
} {
  const peak = Math.max(1, ...points.map(pointTotal));
  const step = Math.max(1, Math.ceil(peak / 4));
  return { step, maximum: step * 4 };
}

// One-sentence text alternative of a chart: totals per series and the busiest bucket.
export function chartSummary(
  title: string,
  series: ChartSeries[],
  points: ChartPoint[],
  size: StatsBucket,
): string {
  if (points.length === 0) return `${title} : aucune donnée.`;
  const totals = series.map((s) => {
    const sum = points.reduce(
      (acc, point) => acc + (point.values[s.key] ?? 0),
      0,
    );
    return `${formatCount(sum)} ${s.label.toLowerCase()}`;
  });
  const grand = points.reduce((acc, point) => acc + pointTotal(point), 0);
  if (grand === 0)
    return `${title} : aucun élément sur les ${formatCount(points.length)} périodes (UTC).`;
  const busiest = points.reduce(
    (best, point) => (pointTotal(point) > pointTotal(best) ? point : best),
    points[0] as ChartPoint,
  );
  return `${title} (UTC) : ${totals.join(", ")} sur ${formatCount(points.length)} périodes ; pic le ${bucketLongLabel(busiest.bucket, size)} avec ${formatCount(pointTotal(busiest))}.`;
}

export function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + value, 0);
}

// Nothing recorded at all for the mission (totals, not the window): the tab then shows an honest empty state.
export function hasNoHistory(stats: MissionStatistics): boolean {
  return (
    sumValues(stats.results_by_status) +
      sumValues(stats.tasks_by_status) +
      sumValues(stats.sessions_by_status) +
      sumValues(stats.logs_by_event_type) ===
    0
  );
}

export function agentAcceptanceRate(agent: AgentStats): number | null {
  const decided = agent.accepted + agent.rejected;
  return decided === 0 ? null : agent.accepted / decided;
}
