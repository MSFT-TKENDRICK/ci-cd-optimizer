import { describe, expect, it } from "vitest";
import { buildSeries, detectAnomalies, detectRegression, detectSpike, hasRecovered, seriesFingerprint } from "../../src/alerts/anomaly.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { seriesOf, snapshot, stable } from "./fixtures.js";

const settings = DEFAULT_CONFIG.alerts;

describe("buildSeries", () => {
  it("builds context-scoped series only from fully successful first attempts, oldest first", () => {
    const series = buildSeries([
      snapshot(3, 120, [["build", 60], ["test", 50]]),
      snapshot(1, 100, [["build", 50], ["test", 40]]),
      snapshot(2, 500, [["build", 400]], "failure"),
      snapshot(4, 130, [["build", 70], ["test", 55, "failure"]]),
    ]);
    const byKey = Object.fromEntries(series.map((entry) => [entry.jobKey ?? "*", entry.points.map((point) => point.runId)]));
    expect(byKey).toEqual({ "*": [1, 3], build: [1, 3], test: [1, 3] });
    expect(series.every((entry) => seriesFingerprint(entry).includes(entry.contextKey!))).toBe(true);
  });
});

describe("detectSpike", () => {
  it("flags a large single-run spike as critical", () => {
    const alert = detectSpike(seriesOf([...stable(20, 300), 620]), settings);
    expect(alert).toMatchObject({ kind: "spike", severity: "critical", runId: 1020, baselineSamples: 20 });
    expect(alert?.increasePercent).toBeGreaterThan(100);
    expect(alert?.zScore).toBeGreaterThan(settings.zThreshold * 2);
  });

  it("flags a moderate spike as a warning", () => {
    const alert = detectSpike(seriesOf([...stable(20, 300), 380]), settings);
    expect(alert).toMatchObject({ kind: "spike", severity: "warning" });
  });

  it("ignores increases below the relative or absolute materiality thresholds", () => {
    expect(detectSpike(seriesOf([...stable(20, 300), 340]), settings)).toBeUndefined();
    expect(detectSpike(seriesOf([...stable(20, 60), 85]), settings)).toBeUndefined();
  });

  it("does not alert on noisy series where the run is within normal variation", () => {
    const noisy = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 200 : 400) + index);
    expect(detectSpike(seriesOf([...noisy, 470]), settings)).toBeUndefined();
  });

  it("requires minSamples of history", () => {
    expect(detectSpike(seriesOf([...stable(5, 300), 900]), settings)).toBeUndefined();
  });

  it("does not alert on faster runs", () => {
    expect(detectSpike(seriesOf([...stable(20, 300), 60]), settings)).toBeUndefined();
  });
});

describe("detectRegression", () => {
  it("detects a sustained step change with Mann-Whitney U", () => {
    const alert = detectRegression(seriesOf([...stable(30, 300), ...stable(5, 400, 50)]), settings);
    expect(alert).toMatchObject({ kind: "regression", severity: "warning", baselineSamples: 30 });
    expect(alert?.recentRunIds).toEqual([1030, 1031, 1032, 1033, 1034]);
    expect(alert?.pValue).toBeLessThan(0.001);
  });

  it("marks regressions of 50% or more as critical", () => {
    expect(detectRegression(seriesOf([...stable(30, 300), ...stable(5, 480, 50)]), settings)?.severity).toBe("critical");
  });

  it("ignores a single outlier inside the recent window", () => {
    expect(detectRegression(seriesOf([...stable(30, 300), ...stable(4, 300, 60), 900]), settings)).toBeUndefined();
  });

  it("ignores statistically significant but immaterial shifts", () => {
    expect(detectRegression(seriesOf([...stable(30, 300), ...stable(5, 320, 50)]), settings)).toBeUndefined();
  });
});

describe("detectAnomalies", () => {
  it("prefers a regression over a spike for the same series and sorts by increase", () => {
    const alerts = detectAnomalies(
      [
        seriesOf([...stable(30, 300), ...stable(5, 400, 50)]),
        seriesOf([...stable(30, 100), ...stable(4, 100, 70), 400], { jobKey: "test" }),
      ],
      settings,
    );
    expect(alerts.map((alert) => [alert.fingerprint, alert.kind])).toEqual([
      ["duration:7/test", "spike"],
      ["duration:7/*", "regression"],
    ]);
  });
});

describe("hasRecovered", () => {
  it("requires recoveryRuns consecutive normal runs", () => {
    const base = stable(20, 300);
    expect(hasRecovered(seriesOf([...base, 600, 305, 302, 298]), 300_000, settings)).toBe(true);
    expect(hasRecovered(seriesOf([...base, 600, 305, 302]), 300_000, settings)).toBe(false);
    expect(hasRecovered(seriesOf([...base, 305, 600, 302]), 300_000, settings)).toBe(false);
    expect(hasRecovered(seriesOf([300, 300]), 300_000, settings)).toBe(false);
  });
});
