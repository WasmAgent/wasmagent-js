/**
 * MCP Tool Descriptor Snapshot — rug-pull detection and hash-based integrity.
 *
 * Implements the first layer of the MCP Firewall (P0 alpha):
 *   1. Snapshot a tool's description and inputSchema at first-seen time.
 *   2. Detect rug-pull: description or schema changed since last snapshot.
 *
 * No ML — purely deterministic SHA-256 hashes.
 *
 * @example
 * ```ts
 * const snap = snapshotTool(entry, "my-mcp-server");
 * const event = detectRugPull(snap, updatedEntry);
 * if (event) console.warn("Rug pull detected on", event.toolName);
 * ```
 */

import { createHash } from "node:crypto";
import type { McpToolEntry } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type TrustTier = "trusted" | "untrusted" | "unknown";

/**
 * Immutable snapshot of a tool's identity fields at a point in time.
 * Store this; compare against future `McpToolEntry` values to detect drift.
 */
export interface ToolDescriptorSnapshot {
  serverId: string;
  toolName: string;
  /** SHA-256 hex of `entry.description`. */
  descriptionHash: string;
  /** SHA-256 hex of `JSON.stringify(entry.inputSchema)`. */
  inputSchemaHash: string;
  /** `Date.now()` ms when this snapshot was first created. */
  firstSeenAt: number;
  trustTier: TrustTier;
}

/**
 * Emitted when a field in a tool's descriptor changes after it was snapshotted.
 * Receiving this event means the tool should be re-reviewed before use.
 */
export interface ToolRugPullEvent {
  toolName: string;
  field: "description" | "inputSchema";
  oldHash: string;
  newHash: string;
  /** `Date.now()` ms when the drift was detected. */
  detectedAt: number;
}

// ── Implementation ───────────────────────────────────────────────────────────

/** SHA-256 hex hash of an arbitrary string. Stable across runs. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Create a `ToolDescriptorSnapshot` from a `McpToolEntry`.
 *
 * @param entry    The tool as returned by the MCP server's `tools/list`.
 * @param serverId Stable identifier for the server (e.g. its `serverInfo.name`).
 * @param opts.trustTier  Defaults to `"unknown"` until explicitly elevated.
 * @param opts.nowMs      Override `Date.now()` for deterministic tests.
 */
export function snapshotTool(
  entry: McpToolEntry,
  serverId: string,
  opts?: { trustTier?: TrustTier; nowMs?: number }
): ToolDescriptorSnapshot {
  return {
    serverId,
    toolName: entry.name,
    descriptionHash: hashContent(entry.description),
    inputSchemaHash: hashContent(JSON.stringify(entry.inputSchema)),
    firstSeenAt: opts?.nowMs ?? Date.now(),
    trustTier: opts?.trustTier ?? "unknown",
  };
}

/**
 * Compare a stored snapshot against the current tool entry.
 *
 * Returns the first changed field as a `ToolRugPullEvent`, or `null` if
 * both hashes still match (no drift).
 *
 * Description is checked before inputSchema so the returned event is
 * deterministic when both change simultaneously.
 */
export function detectRugPull(
  prev: ToolDescriptorSnapshot,
  curr: McpToolEntry
): ToolRugPullEvent | null {
  const descHash = hashContent(curr.description);
  if (descHash !== prev.descriptionHash) {
    return {
      toolName: curr.name,
      field: "description",
      oldHash: prev.descriptionHash,
      newHash: descHash,
      detectedAt: Date.now(),
    };
  }
  const schemaHash = hashContent(JSON.stringify(curr.inputSchema));
  if (schemaHash !== prev.inputSchemaHash) {
    return {
      toolName: curr.name,
      field: "inputSchema",
      oldHash: prev.inputSchemaHash,
      newHash: schemaHash,
      detectedAt: Date.now(),
    };
  }
  return null;
}
