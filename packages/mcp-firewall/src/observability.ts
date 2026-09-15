/**
 * Observability types and in-memory recorder for mcp-firewall.
 *
 * Counter names follow OpenTelemetry/Prometheus naming conventions and can be
 * used verbatim with any metrics backend (OTel meter, Cloudflare Analytics
 * Engine, in-process counter map).
 */

import type { FirewallSecurityVerdict } from "./verdict.js";

// ── Metric names ──────────────────────────────────────────────────────────────

export const FIREWALL_METRIC_NAMES = {
  DETECTION_BLOCK_TOTAL: "firewall_detection_block_total",
  POLICY_DENY_TOTAL: "firewall_policy_deny_total",
  CONSENT_ASK_TOTAL: "firewall_consent_ask_total",
  DETECTOR_MISS_CONTAINED_TOTAL: "firewall_detector_miss_contained_total",
  UNSAFE_ESCAPE_TOTAL: "firewall_unsafe_escape_total",
  RUGPULL_TOTAL: "firewall_rugpull_total",
  TAINT_BLOCK_TOTAL: "firewall_taint_block_total",
} as const;

export type FirewallMetricName =
  (typeof FIREWALL_METRIC_NAMES)[keyof typeof FIREWALL_METRIC_NAMES];

export interface FirewallMetricEvent {
  metric: FirewallMetricName;
  value: number;
  timestamp: string;
  dimensions?: {
    toolName?: string;
    category?: string;
    mutatorName?: string;
    phase?: string;
  };
}

export interface FirewallMetricsRecorder {
  increment(
    metric: FirewallMetricName,
    dimensions?: FirewallMetricEvent["dimensions"]
  ): void;
  snapshot(): Record<FirewallMetricName, number>;
}

// ── In-memory recorder ────────────────────────────────────────────────────────

export class InMemoryMetricsRecorder implements FirewallMetricsRecorder {
  readonly #counters: Map<string, number> = new Map();

  increment(
    metric: FirewallMetricName,
    _dimensions?: FirewallMetricEvent["dimensions"]
  ): void {
    this.#counters.set(metric, (this.#counters.get(metric) ?? 0) + 1);
  }

  snapshot(): Record<FirewallMetricName, number> {
    const result = {} as Record<FirewallMetricName, number>;
    for (const name of Object.values(FIREWALL_METRIC_NAMES)) {
      result[name] = this.#counters.get(name) ?? 0;
    }
    return result;
  }

  reset(): void {
    this.#counters.clear();
  }
}

// ── Verdict → metrics ─────────────────────────────────────────────────────────

/**
 * Map a FirewallSecurityVerdict to the metric counter(s) to increment.
 * Call this after every gateway decision to produce structured observability.
 */
export function verdictToMetrics(verdict: FirewallSecurityVerdict): FirewallMetricName[] {
  const metrics: FirewallMetricName[] = [];

  if (verdict.detection === "blocked") {
    metrics.push(FIREWALL_METRIC_NAMES.DETECTION_BLOCK_TOTAL);
  }
  if (verdict.policy === "deny") {
    metrics.push(FIREWALL_METRIC_NAMES.POLICY_DENY_TOTAL);
  }
  if (verdict.policy === "ask_user") {
    metrics.push(FIREWALL_METRIC_NAMES.CONSENT_ASK_TOTAL);
  }
  if (verdict.detection === "missed" && verdict.containment === "contained") {
    metrics.push(FIREWALL_METRIC_NAMES.DETECTOR_MISS_CONTAINED_TOTAL);
  }
  if (verdict.detection === "missed" && verdict.containment === "escaped") {
    metrics.push(FIREWALL_METRIC_NAMES.UNSAFE_ESCAPE_TOTAL);
  }
  if (verdict.taint === "tainted") {
    metrics.push(FIREWALL_METRIC_NAMES.TAINT_BLOCK_TOTAL);
  }

  return metrics;
}
