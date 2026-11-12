import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { MissionStatistics } from "../api/missions";
import { type ApiReply, stubApi } from "../test/render";
import { MISSION } from "./missionTestData";
import { StatsTab } from "./StatsTab";
import {
  axisFor,
  bucketLongLabel,
  bucketShortLabel,
  chartSummary,
  countPoints,
  formatDuration,
  formatRate,
  resultPoints,
  RESULT_SERIES,
} from "./statsModel";

const ROUTE = `GET /api/missions/${MISSION}/statistics`;

function stats(overrides: Partial<MissionStatistics> = {}): MissionStatistics {
  const days = overrides.days ?? 30;
  const bucket = overrides.bucket ?? "day";
  const buckets = Array.from(
    { length: 3 },
    (_, i) => `2026-11-${String(10 + i)}T00:00:00Z`,
  );
  return {
    bucket,
    days,
    since: "2026-10-13T00:00:00Z",
    until: "2026-11-12T10:00:00Z",
    results_by_status: {
      pending_review: 1,
      accepted: 3,
      rejected: 1,
      superseded: 0,
    },
    tasks_by_status: {
      pending: 0,
      claimed: 1,
      submitted: 1,
      accepted: 3,
      failed: 2,
      cancelled: 0,
    },
    sessions_by_status: { active: 1, ended: 2, timed_out: 1 },
    logs_by_event_type: {
      search: 4,
      source_opened: 6,
      observation: 0,
      verification: 2,
      progress: 1,
      warning: 1,
      error: 3,
      decision_summary: 0,
    },
    results_series: buckets.map((b, i) => ({
      bucket: b,
      pending_review: 0,
      accepted: i === 1 ? 3 : 0,
      rejected: i === 1 ? 1 : 0,
      superseded: 0,
    })),
    sessions_series: buckets.map((b, i) => ({
      bucket: b,
      count: i === 2 ? 4 : 0,
    })),
    logs_series: buckets.map((b, i) => ({ bucket: b, count: i === 0 ? 0 : 8 })),
    decided_count: 4,
    acceptance_rate: 0.75,
    avg_review_seconds: 1200,
    agents: [
      {
        agent_id: "a1",
        agent_label: "Agent claude-01",
        sessions: 3,
        logs: 10,
        results: 4,
        accepted: 3,
        rejected: 1,
        pending_review: 0,
      },
      {
        agent_id: "a2",
        agent_label: "Agent claude-02",
        sessions: 1,
        logs: 5,
        results: 1,
        accepted: 0,
        rejected: 0,
        pending_review: 1,
      },
    ],
    ...overrides,
  };
}

function empty(): MissionStatistics {
  return stats({
    results_by_status: {
      pending_review: 0,
      accepted: 0,
      rejected: 0,
      superseded: 0,
    },
    tasks_by_status: {
      pending: 0,
      claimed: 0,
      submitted: 0,
      accepted: 0,
      failed: 0,
      cancelled: 0,
    },
    sessions_by_status: { active: 0, ended: 0, timed_out: 0 },
    logs_by_event_type: {
      search: 0,
      source_opened: 0,
      observation: 0,
      verification: 0,
      progress: 0,
      warning: 0,
      error: 0,
      decision_summary: 0,
    },
    acceptance_rate: null,
    avg_review_seconds: null,
    decided_count: 0,
    agents: [],
  });
}

function renderTab(reply: ApiReply) {
  const fetchMock = stubApi({ [ROUTE]: reply });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StatsTab missionId={MISSION} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

function lastQuery(fetchMock: ReturnType<typeof stubApi>): URLSearchParams {
  const calls = fetchMock.mock.calls as unknown as [string][];
  const last = calls[calls.length - 1]?.[0] ?? "";
  return new URL(last, "http://localhost").searchParams;
}

// First card of that name (« À relire » is both a result and a task label).
function kpi(label: string): HTMLElement {
  return screen.getAllByText(label, { selector: "dt" })[0]
    ?.parentElement as HTMLElement;
}

describe("Statistiques tab", () => {
  it("renders the KPI cards from the API", async () => {
    renderTab([200, stats()]);
    await screen.findByText("Taux d’acceptation", { selector: "dt" });

    expect(within(kpi("Acceptés")).getByText("3")).toBeInTheDocument();
    expect(within(kpi("Refusés")).getByText("1")).toBeInTheDocument();
    expect(within(kpi("À relire")).getByText("1")).toBeInTheDocument();
    expect(
      within(kpi("Taux d’acceptation")).getByText("75 %"),
    ).toBeInTheDocument();
    expect(
      within(kpi("Délai moyen de relecture")).getByText("20 min"),
    ).toBeInTheDocument();
    expect(within(kpi("Échec")).getByText("2")).toBeInTheDocument();
    expect(within(kpi("Sessions")).getByText("4")).toBeInTheDocument();
    expect(within(kpi("Journaux")).getByText("17")).toBeInTheDocument();
    expect(within(kpi("Sources ouvertes")).getByText("6")).toBeInTheDocument();
  });

  it("shows a dash, not a fake rate, until a result is decided", async () => {
    renderTab([
      200,
      stats({ acceptance_rate: null, avg_review_seconds: null }),
    ]);
    await screen.findByText("Taux d’acceptation", { selector: "dt" });
    expect(
      within(kpi("Taux d’acceptation")).getByText("—"),
    ).toBeInTheDocument();
    expect(
      within(kpi("Délai moyen de relecture")).getByText("—"),
    ).toBeInTheDocument();
  });

  it("lists agents and the event-type breakdown", async () => {
    renderTab([200, stats()]);
    const table = await screen.findByRole("table", { name: /par agent/i });
    const rows = within(table).getAllByRole("row");
    expect(
      within(rows[1] as HTMLElement).getByText("Agent claude-01"),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText("75 %"),
    ).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("—")).toBeInTheDocument();
    const events = screen.getByRole("heading", { name: /type d’événement/i })
      .parentElement as HTMLElement;
    expect(within(events).getAllByRole("listitem")).toHaveLength(8);
    expect(
      within(events).getByText("Sources ouvertes").parentElement,
    ).toHaveTextContent("6");
  });

  it("asks for day buckets over 30 days first, then the toggles change the query", async () => {
    const user = userEvent.setup();
    const fetchMock = renderTab([200, stats()]);
    await screen.findByText("Taux d’acceptation", { selector: "dt" });
    expect(Object.fromEntries(lastQuery(fetchMock))).toEqual({
      bucket: "day",
      days: "30",
    });

    await user.click(screen.getByRole("button", { name: "90 jours" }));
    await waitFor(() => {
      expect(lastQuery(fetchMock).get("days")).toBe("90");
    });

    await user.click(screen.getByRole("button", { name: "Par heure" }));
    await waitFor(() => {
      expect(Object.fromEntries(lastQuery(fetchMock))).toEqual({
        bucket: "hour",
        days: "7",
      });
    });
    expect(screen.getByRole("button", { name: "30 jours" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "90 jours" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Par heure" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Par jour" }));
    await waitFor(() => {
      expect(Object.fromEntries(lastQuery(fetchMock))).toEqual({
        bucket: "day",
        days: "7",
      });
    });
    expect(screen.getByRole("button", { name: "30 jours" })).toBeEnabled();
  });

  it("keeps the previous figures on screen while a new range loads", async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderTab((url) =>
      url.searchParams.get("days") === "90" ? pending : [200, stats()],
    );
    await screen.findByText("Taux d’acceptation", { selector: "dt" });

    await user.click(screen.getByRole("button", { name: "90 jours" }));
    expect(await screen.findByText("Mise à jour des chiffres…")).toBeVisible();
    expect(screen.getByText("Taux d’acceptation", { selector: "dt" })).toBeVisible();
    expect(screen.queryByText("Chargement des statistiques…")).toBeNull();

    release(
      new Response(JSON.stringify(stats({ days: 90 })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Mise à jour des chiffres…")).toBeNull();
    });
  });

  it("says buckets are UTC", async () => {
    renderTab([200, stats()]);
    expect(await screen.findByText(/bornes UTC/)).toBeInTheDocument();
  });

  it("shows loading, then an error with retry", async () => {
    const user = userEvent.setup();
    let fail = true;
    renderTab(() => (fail ? [500, { detail: "boom" }] : [200, stats()]));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Chargement des statistiques",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("indisponibles");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(
      await screen.findByText("Taux d’acceptation", { selector: "dt" }),
    ).toBeInTheDocument();
  });

  it("shows an honest empty state without any figure when nothing happened", async () => {
    renderTab([200, empty()]);
    expect(
      await screen.findByText("Aucune statistique pour l’instant"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Taux d’acceptation")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("gives every chart a text summary and a data table, zero buckets included", async () => {
    const user = userEvent.setup();
    renderTab([200, stats()]);
    await screen.findByText("Taux d’acceptation", { selector: "dt" });

    const plots = screen.getAllByRole("img");
    expect(plots).toHaveLength(3);
    expect(plots[0]).toHaveAccessibleName(
      /Résultats déposés \(UTC\) : 3 acceptés, 1 refusés, 0 à relire, 0 remplacés sur 3 périodes/,
    );
    expect(plots[1]).toHaveAccessibleName(
      /Journaux des agents \(UTC\) : 16 journaux/,
    );

    expect(screen.getAllByRole("region", { name: /graphique/ })).toHaveLength(
      3,
    );
    const summaries = screen.getAllByText("Voir les données en tableau");
    await user.click(summaries[0] as HTMLElement);
    const table = screen.getByRole("table", {
      name: "Résultats déposés : données (UTC)",
    });
    // header + the three buckets, the empty ones are rows with zeros (not skipped)
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(
      within(within(table).getAllByRole("row")[1] as HTMLElement).getAllByText(
        "0",
      ).length,
    ).toBeGreaterThan(3);
  });
});

describe("chart data transformations", () => {
  const data = stats();

  it("maps the results series to one point per bucket", () => {
    const points = resultPoints(data);
    expect(points).toHaveLength(3);
    expect(points[1]?.values).toEqual({
      accepted: 3,
      rejected: 1,
      pending_review: 0,
      superseded: 0,
    });
  });

  it("scales the axis in four steps and never to zero", () => {
    expect(axisFor(countPoints([{ bucket: "x", count: 0 }]))).toEqual({
      step: 1,
      maximum: 4,
    });
    expect(axisFor(countPoints([{ bucket: "x", count: 9 }]))).toEqual({
      step: 3,
      maximum: 12,
    });
  });

  it("formats UTC buckets regardless of the local timezone", () => {
    expect(bucketShortLabel("2026-11-12T23:00:00Z", "day")).toBe("12/11");
    expect(bucketShortLabel("2026-11-12T23:00:00Z", "hour")).toBe("12/11 23 h");
    expect(bucketLongLabel("2026-11-12T00:00:00Z", "day")).toMatch(
      /12 nov\.? 2026/,
    );
  });

  it("summarises an all-zero series without inventing a peak", () => {
    const zero = countPoints([{ bucket: "2026-11-12T00:00:00Z", count: 0 }]);
    expect(
      chartSummary(
        "Sessions",
        [{ key: "count", label: "Sessions", tone: "accent" }],
        zero,
        "day",
      ),
    ).toBe("Sessions : aucun élément sur les 1 périodes (UTC).");
    expect(chartSummary("X", RESULT_SERIES, [], "day")).toBe(
      "X : aucune donnée.",
    );
  });

  it("formats durations and rates", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(1200)).toBe("20 min");
    expect(formatDuration(3900)).toBe("1 h 05");
    expect(formatDuration(200000)).toBe("2 j 7 h");
    expect(formatRate(0.5)).toBe("50 %");
    expect(formatRate(null)).toBe("—");
  });
});
