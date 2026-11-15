import type { CSSProperties } from "react";

import type { StatsBucket } from "../api/missions";
import { Table } from "../ui/Table";
import {
  axisFor,
  bucketLongLabel,
  bucketShortLabel,
  type ChartPoint,
  type ChartSeries,
  chartSummary,
  formatCount,
  pointTotal,
} from "./statsModel";

interface StatsChartProps {
  id: string;
  title: string;
  series: ChartSeries[];
  points: ChartPoint[];
  bucket: StatsBucket;
  // Inside a MissionPanel that already shows the title: keep the name for assistive tech only (h4 under the panel h3).
  hideTitle?: boolean;
  // Table mode (switched from the panel header): the same figures as a table instead of the plot.
  asTable?: boolean;
}

// Hand-rolled stacked column chart (no chart library in the repo; same approach as ContactChart). The plot is
// decorative for assistive tech: its text alternative is the `role="img"` summary plus a full data table that
// sits in a disclosure (keyboard-reachable). Colours come from tokens; every series is also named in the legend
// and in the table, so colour is never the only channel. Zero buckets are drawn (empty column), not skipped.
export function StatsChart({
  id,
  title,
  series,
  points,
  bucket,
  hideTitle = false,
  asTable = false,
}: StatsChartProps) {
  const { step, maximum } = axisFor(points);
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  const multi = series.length > 1;
  const summary = chartSummary(title, series, points, bucket);
  // Inside a titled MissionPanel the panel is already the named region: a second landmark with the same name is noise.
  const Wrapper = hideTitle ? "div" : "section";

  return (
    <Wrapper
      className="stats-chart"
      aria-labelledby={hideTitle ? undefined : `${id}-title`}
    >
      {hideTitle ? (
        <h4 id={`${id}-title`} className="visually-hidden">
          {title}
        </h4>
      ) : (
        <h3 id={`${id}-title`} className="stats-chart__title">
          {title}
        </h3>
      )}
      {!asTable && (
        <ul className="stats-legend" aria-label="Légende">
          {series.map((s) => (
            <li key={s.key} className="stats-legend__item">
              <span
                className={`stats-swatch stats-tone--${s.tone}`}
                aria-hidden="true"
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {asTable ? (
        <div className="stats-chart__data">
        <Table caption={`${title} : données (UTC)`} density="compact">
          <thead>
            <tr>
              <th scope="col">Période (UTC)</th>
              {series.map((s) => (
                <th scope="col" key={s.key} className="stats-num">
                  {s.label}
                </th>
              ))}
              {multi && (
                <th scope="col" className="stats-num">
                  Total
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.bucket}>
                <th scope="row">{bucketLongLabel(point.bucket, bucket)}</th>
                {series.map((s) => (
                  <td key={s.key} className="stats-num">
                    {formatCount(point.values[s.key] ?? 0)}
                  </td>
                ))}
                {multi && (
                  <td className="stats-num">
                    {formatCount(pointTotal(point))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
        </div>
      ) : (
      <div
        className="stats-chart__scroll"
        role="region"
        aria-label={`${title} : graphique`}
        tabIndex={0}
      >
        <div
          className="stats-chart__canvas"
          style={{ "--stats-columns": points.length } as CSSProperties}
        >
          <div className="stats-chart__plot" role="img" aria-label={summary}>
            <div className="stats-chart__grid" aria-hidden="true">
              {[4, 3, 2, 1, 0].map((tick) => (
                <div key={tick}>
                  <span>{formatCount(step * tick)}</span>
                  <i />
                </div>
              ))}
            </div>
            <div className="stats-chart__columns" aria-hidden="true">
              {points.map((point) => (
                <div
                  className="stats-chart__column"
                  key={point.bucket}
                  title={`${bucketLongLabel(point.bucket, bucket)} (UTC) : ${formatCount(pointTotal(point))}`}
                >
                  <div
                    className="stats-chart__stack"
                    style={{
                      height: `${String((pointTotal(point) / maximum) * 100)}%`,
                    }}
                  >
                    {series.map((s) => {
                      const value = point.values[s.key] ?? 0;
                      return value > 0 ? (
                        <span
                          key={s.key}
                          className={`stats-tone--${s.tone}`}
                          style={{ flexGrow: value }}
                        />
                      ) : null;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="stats-chart__labels" aria-hidden="true">
            {points.map((point, index) => (
              <span key={point.bucket}>
                {index % labelEvery === 0
                  ? bucketShortLabel(point.bucket, bucket)
                  : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
      )}
    </Wrapper>
  );
}
