export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const POSTURE_REQUIRED = ['posture_version', 'identity', 'servers', 'attestation'] as const;
const IDENTITY_REQUIRED = ['snapshot_id', 'agent_id', 'captured_at'] as const;

export const RISK_CATEGORIES = [
  'ssrf',
  'exfiltration',
  'command_execution',
  'privilege_escalation',
  'prompt_injection',
  'credential_access',
  'supply_chain',
  'mcp_header_leakage',
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export type SessionModel = 'stateful' | 'stateless-handle' | 'unknown';
export type HandleExpiryPolicy = 'short-lived' | 'long-lived' | 'unset';

export interface McpPostureAuth {
  audience_bound_token_validated?: boolean;
  pkce_used?: boolean;
  per_client_consent_verified?: boolean;
}

// --- Diff types and logic ---

interface ServerEntry {
  server_id: string;
  server_name: string;
  tools: Map<string, ToolEntry>;
}

interface ToolEntry {
  tool_id: string;
  tool_name: string;
  permissions: string[];
  risk_categories: string[];
  risk_severity: string;
}

interface RiskEntry {
  finding_id: string;
  severity: string;
  category: string;
  description: string;
}

export interface PostureDiff {
  servers: {
    added: string[];
    removed: string[];
  };
  tools: {
    added: { server_id: string; tool: ToolEntry }[];
    removed: { server_id: string; tool: ToolEntry }[];
    modified: { server_id: string; tool_id: string; field: string; old: string; new: string }[];
  };
  permissions: {
    added: string[];
    removed: string[];
  };
  risks: {
    added: RiskEntry[];
    removed: RiskEntry[];
    modified: { finding_id: string; field: string; old: string; new: string }[];
  };
  isEmpty(): boolean;
}

export function createPostureDiff(partial: Omit<PostureDiff, 'isEmpty'>): PostureDiff {
  const isEmpty = (): boolean =>
    partial.servers.added.length === 0 &&
    partial.servers.removed.length === 0 &&
    partial.tools.added.length === 0 &&
    partial.tools.removed.length === 0 &&
    partial.tools.modified.length === 0 &&
    partial.permissions.added.length === 0 &&
    partial.permissions.removed.length === 0 &&
    partial.risks.added.length === 0 &&
    partial.risks.removed.length === 0 &&
    partial.risks.modified.length === 0;

  return { ...partial, isEmpty };
}

function toArray(val: unknown): unknown[] {
  return Array.isArray(val) ? val : [];
}

function parseServers(servers: unknown): Map<string, ServerEntry> {
  const map = new Map<string, ServerEntry>();
  for (const item of toArray(servers)) {
    if (typeof item === 'object' && item !== null) {
      const s = item as Record<string, unknown>;
      if (typeof s.server_id === 'string') {
        const tools = new Map<string, ToolEntry>();
        for (const t of toArray(s.tools)) {
          if (typeof t === 'object' && t !== null) {
            const tool = t as Record<string, unknown>;
            if (typeof tool.tool_id === 'string') {
              tools.set(tool.tool_id, {
                tool_id: tool.tool_id,
                tool_name: String(tool.tool_name ?? ''),
                permissions: toArray(tool.permissions).map(String),
                risk_categories: toArray(tool.risk_categories).map(String),
                risk_severity: String(tool.risk_severity ?? ''),
              });
            }
          }
        }
        map.set(s.server_id, {
          server_id: s.server_id,
          server_name: String(s.server_name ?? ''),
          tools,
        });
      }
    }
  }
  return map;
}

function parseRisks(riskSummary: unknown): Map<string, RiskEntry> {
  const map = new Map<string, RiskEntry>();
  for (const item of toArray(riskSummary)) {
    if (typeof item === 'object' && item !== null) {
      const r = item as Record<string, unknown>;
      if (typeof r.finding_id === 'string') {
        map.set(r.finding_id, {
          finding_id: r.finding_id,
          severity: String(r.severity ?? ''),
          category: String(r.category ?? ''),
          description: String(r.description ?? ''),
        });
      }
    }
  }
  return map;
}

function diffStringArrays(
  oldArr: string[],
  newArr: string[],
): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  return {
    added: newArr.filter((s) => !oldSet.has(s)),
    removed: oldArr.filter((s) => !newSet.has(s)),
  };
}

export function diffMCPPosture(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
): PostureDiff {
  const oldServers = parseServers(oldData.servers);
  const newServers = parseServers(newData.servers);

  const serversAdded: string[] = [];
  const serversRemoved: string[] = [];
  const toolsAdded: { server_id: string; tool: ToolEntry }[] = [];
  const toolsRemoved: { server_id: string; tool: ToolEntry }[] = [];
  const toolsModified: {
    server_id: string;
    tool_id: string;
    field: string;
    old: string;
    new: string;
  }[] = [];

  for (const [id, server] of newServers) {
    if (!oldServers.has(id)) {
      serversAdded.push(id);
      for (const [, tool] of server.tools) {
        toolsAdded.push({ server_id: id, tool });
      }
    }
  }
  for (const [id, server] of oldServers) {
    if (!newServers.has(id)) {
      serversRemoved.push(id);
      for (const [, tool] of server.tools) {
        toolsRemoved.push({ server_id: id, tool });
      }
    }
  }
  for (const [id, newServer] of newServers) {
    const oldServer = oldServers.get(id);
    if (!oldServer) continue;

    for (const [toolId, newTool] of newServer.tools) {
      if (!oldServer.tools.has(toolId)) {
        toolsAdded.push({ server_id: id, tool: newTool });
      }
    }
    for (const [toolId, oldTool] of oldServer.tools) {
      if (!newServer.tools.has(toolId)) {
        toolsRemoved.push({ server_id: id, tool: oldTool });
      }
    }
    for (const [toolId, newTool] of newServer.tools) {
      const oldTool = oldServer.tools.get(toolId);
      if (!oldTool) continue;

      const permDiff = diffStringArrays(oldTool.permissions, newTool.permissions);
      for (const p of permDiff.added) {
        toolsModified.push({
          server_id: id,
          tool_id: toolId,
          field: 'permissions',
          old: '',
          new: p,
        });
      }
      for (const p of permDiff.removed) {
        toolsModified.push({
          server_id: id,
          tool_id: toolId,
          field: 'permissions',
          old: p,
          new: '',
        });
      }

      const catDiff = diffStringArrays(oldTool.risk_categories, newTool.risk_categories);
      for (const c of catDiff.added) {
        toolsModified.push({
          server_id: id,
          tool_id: toolId,
          field: 'risk_category',
          old: '',
          new: c,
        });
      }
      for (const c of catDiff.removed) {
        toolsModified.push({
          server_id: id,
          tool_id: toolId,
          field: 'risk_category',
          old: c,
          new: '',
        });
      }

      if (oldTool.risk_severity !== newTool.risk_severity) {
        toolsModified.push({
          server_id: id,
          tool_id: toolId,
          field: 'risk_severity',
          old: oldTool.risk_severity,
          new: newTool.risk_severity,
        });
      }
    }
  }

  // Permission scope diff from permission_graph
  const oldScopes = toArray(
    (oldData.permission_graph as Record<string, unknown> | undefined)?.permission_scopes,
  ).map(String);
  const newScopes = toArray(
    (newData.permission_graph as Record<string, unknown> | undefined)?.permission_scopes,
  ).map(String);
  const permChanges = diffStringArrays(oldScopes, newScopes);

  // Risk summary diff
  const oldRisks = parseRisks(oldData.risk_summary);
  const newRisks = parseRisks(newData.risk_summary);

  const risksAdded: RiskEntry[] = [];
  const risksRemoved: RiskEntry[] = [];
  const risksModified: { finding_id: string; field: string; old: string; new: string }[] = [];

  for (const [id, risk] of newRisks) {
    if (!oldRisks.has(id)) risksAdded.push(risk);
  }
  for (const [id, risk] of oldRisks) {
    if (!newRisks.has(id)) risksRemoved.push(risk);
  }
  for (const [id, newRisk] of newRisks) {
    const oldRisk = oldRisks.get(id);
    if (!oldRisk) continue;
    if (oldRisk.severity !== newRisk.severity) {
      risksModified.push({
        finding_id: id,
        field: 'severity',
        old: oldRisk.severity,
        new: newRisk.severity,
      });
    }
    if (oldRisk.category !== newRisk.category) {
      risksModified.push({
        finding_id: id,
        field: 'category',
        old: oldRisk.category,
        new: newRisk.category,
      });
    }
    if (oldRisk.description !== newRisk.description) {
      risksModified.push({
        finding_id: id,
        field: 'description',
        old: oldRisk.description,
        new: newRisk.description,
      });
    }
  }

  return createPostureDiff({
    servers: { added: serversAdded, removed: serversRemoved },
    tools: { added: toolsAdded, removed: toolsRemoved, modified: toolsModified },
    permissions: { added: permChanges.added, removed: permChanges.removed },
    risks: { added: risksAdded, removed: risksRemoved, modified: risksModified },
  });
}

export function formatPostureDiff(diff: PostureDiff): string {
  const lines: string[] = [];

  if (diff.servers.added.length > 0) {
    lines.push(`Servers added (${diff.servers.added.length}):`);
    for (const s of diff.servers.added) lines.push(`  + ${s}`);
  }

  if (diff.servers.removed.length > 0) {
    lines.push(`Servers removed (${diff.servers.removed.length}):`);
    for (const s of diff.servers.removed) lines.push(`  - ${s}`);
  }

  if (diff.tools.added.length > 0) {
    lines.push(`Tools added (${diff.tools.added.length}):`);
    for (const t of diff.tools.added) {
      lines.push(`  + ${t.tool.tool_name} (${t.tool.tool_id}) [server: ${t.server_id}]`);
    }
  }

  if (diff.tools.removed.length > 0) {
    lines.push(`Tools removed (${diff.tools.removed.length}):`);
    for (const t of diff.tools.removed) {
      lines.push(`  - ${t.tool.tool_name} (${t.tool.tool_id}) [server: ${t.server_id}]`);
    }
  }

  if (diff.tools.modified.length > 0) {
    lines.push(`Tools changed (${diff.tools.modified.length}):`);
    for (const m of diff.tools.modified) {
      if (m.field === 'permissions' || m.field === 'risk_category') {
        if (m.new) {
          lines.push(`  ~ ${m.tool_id} (${m.server_id}): ${m.field} added: ${m.new}`);
        } else {
          lines.push(`  ~ ${m.tool_id} (${m.server_id}): ${m.field} removed: ${m.old}`);
        }
      } else {
        lines.push(`  ~ ${m.tool_id} (${m.server_id}): ${m.field}: ${m.old} → ${m.new}`);
      }
    }
  }

  if (diff.permissions.added.length > 0) {
    lines.push(`Permission scopes added (${diff.permissions.added.length}):`);
    for (const s of diff.permissions.added) lines.push(`  + ${s}`);
  }

  if (diff.permissions.removed.length > 0) {
    lines.push(`Permission scopes removed (${diff.permissions.removed.length}):`);
    for (const s of diff.permissions.removed) lines.push(`  - ${s}`);
  }

  if (diff.risks.added.length > 0) {
    lines.push(`Risk findings added (${diff.risks.added.length}):`);
    for (const r of diff.risks.added) {
      lines.push(`  + [${r.severity}] ${r.finding_id}: ${r.description}`);
    }
  }

  if (diff.risks.removed.length > 0) {
    lines.push(`Risk findings removed (${diff.risks.removed.length}):`);
    for (const r of diff.risks.removed) {
      lines.push(`  - [${r.severity}] ${r.finding_id}: ${r.description}`);
    }
  }

  if (diff.risks.modified.length > 0) {
    lines.push(`Risk findings changed (${diff.risks.modified.length}):`);
    for (const m of diff.risks.modified) {
      lines.push(`  ~ ${m.finding_id}: ${m.field}: ${m.old} → ${m.new}`);
    }
  }

  if (lines.length === 0) {
    lines.push('No differences found between the two posture snapshots.');
  }

  return lines.join('\n');
}

export function validateMCPPosture(data: unknown): ValidationResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, errors: ['root must be an object'] };
  }
  const d = data as Record<string, unknown>;
  const errors: string[] = [];

  errors.push(...POSTURE_REQUIRED.filter((k) => !(k in d)).map((k) => `missing required: ${k}`));

  if ('posture_version' in d && d.posture_version !== '0.1') {
    errors.push(`posture_version must be "0.1"`);
  }

  if (d.identity && typeof d.identity === 'object') {
    const id = d.identity as Record<string, unknown>;
    errors.push(
      ...IDENTITY_REQUIRED.filter((k) => !(k in id)).map((k) => `identity: missing ${k}`),
    );
  }

  // Validate verification_endpoint if present
  if ('verification_endpoint' in d && typeof d.verification_endpoint === 'string') {
    const url = d.verification_endpoint as string;
    if (!/^https:\/\//.test(url)) {
      errors.push('verification_endpoint must use HTTPS scheme');
    }
    try {
      new URL(url);
    } catch {
      errors.push('verification_endpoint must be a valid URL');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function inspectMCPPosture(data: Record<string, unknown>): string {
  const identity = data.identity as Record<string, string> | undefined;
  const servers = (data.servers as Record<string, unknown>[]) ?? [];
  const risks = (data.risk_summary as Record<string, string>[]) ?? [];
  const permissionGraph = data.permission_graph as Record<string, unknown> | undefined;
  const protocolVersion = (data.protocol_version as string | undefined) ?? 'pre-2026-07-28';

  const totalTools = servers.reduce((sum, s) => sum + ((s.tools as unknown[]) ?? []).length, 0);

  const highRiskTools =
    (permissionGraph?.high_risk_tools as number) ??
    servers.reduce(
      (sum, s) =>
        sum +
        ((s.tools as Record<string, string>[]) ?? []).filter(
          (t) => t.risk_severity === 'critical' || t.risk_severity === 'high',
        ).length,
      0,
    );

  const lines: string[] = [
    `MCP Posture v${data.posture_version} (protocol: ${protocolVersion})`,
    `  Snapshot:        ${identity?.snapshot_id ?? '?'}`,
    `  Agent:           ${identity?.agent_id ?? '?'}`,
    `  Servers:         ${servers.length}`,
    `  Tools:           ${totalTools}`,
    `  High-risk tools: ${highRiskTools}`,
    `  Risks:           ${risks.length}`,
  ];

  const criticalOrHigh = risks.filter((r) => r.severity === 'critical' || r.severity === 'high');

  if (criticalOrHigh.length > 0) {
    lines.push('');
    lines.push(`  ⚠  ${criticalOrHigh.length} critical/high finding(s):`);
    for (const r of criticalOrHigh) {
      const agenticRef = r.owasp_agentic_ref ? ` [${r.owasp_agentic_ref}]` : '';
      lines.push(
        `    [${(r.severity ?? '').toUpperCase()}] ${r.finding_id}: ${r.description}${agenticRef}`,
      );
    }
  }

  if (risks.length > 0 && criticalOrHigh.length < risks.length) {
    const other = risks.filter((r) => r.severity !== 'critical' && r.severity !== 'high');
    lines.push('');
    lines.push('  Other findings:');
    for (const r of other) {
      lines.push(`    [${(r.severity ?? '').toUpperCase()}] ${r.finding_id}: ${r.description}`);
    }
  }

  return lines.join('\n');
}

// --- Semver utilities ---

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
}

export function parseSemver(version: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?(?:\+([\w.]+))?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
    ...(match[5] ? { build: match[5] } : {}),
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid semver: ${!pa ? a : b}`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && pb.prerelease) return pa.prerelease.localeCompare(pb.prerelease);
  return 0;
}

export function isVersionInRange(version: string, range: string): boolean {
  if (range.startsWith('>=')) return compareSemver(version, range.slice(2)) >= 0;
  if (range.startsWith('<=')) return compareSemver(version, range.slice(2)) <= 0;
  if (range.startsWith('>')) return compareSemver(version, range.slice(1)) > 0;
  if (range.startsWith('<')) return compareSemver(version, range.slice(1)) < 0;
  return version === range;
}

// --- Migration framework ---

export type MigrationFn = (data: Record<string, unknown>) => Record<string, unknown>;

export interface MigrationStep {
  fromVersion: string;
  toVersion: string;
  migrate: MigrationFn;
  description: string;
  breaking: boolean;
}

export interface MigrationResult {
  success: boolean;
  fromVersion: string;
  toVersion: string;
  data: Record<string, unknown>;
  stepsApplied: MigrationStep[];
  warnings: string[];
  errors: string[];
}

export interface DeprecationNotice {
  version: string;
  message: string;
  severity: 'info' | 'warn' | 'deprecated';
}

export interface VersionedValidationResult extends ValidationResult {
  version_warnings: DeprecationNotice[];
  detected_version: string | null;
}

/** Currently supported MCP Posture schema versions. */
const SUPPORTED_POSTURE_VERSIONS: readonly string[] = ['0.1'];
const LATEST_POSTURE_VERSION = '0.1';
const DEPRECATED_POSTURE_VERSIONS: Map<string, DeprecationNotice> = new Map();
const POSTURE_MIGRATION_REGISTRY: MigrationStep[] = [];

export function getSupportedVersions(): string[] {
  return [...SUPPORTED_POSTURE_VERSIONS];
}

export function getLatestVersion(): string {
  return LATEST_POSTURE_VERSION;
}

/** Register a migration step. Call at module init time to extend the framework. */
export function registerMigration(step: MigrationStep): void {
  POSTURE_MIGRATION_REGISTRY.push(step);
}

/** Find the shortest migration path from `from` to `to` via registered steps (BFS). */
export function getMigrationPath(fromVersion: string, toVersion: string): MigrationStep[] {
  const visited = new Set<string>([fromVersion]);
  const queue: Array<{ version: string; path: MigrationStep[] }> = [
    { version: fromVersion, path: [] },
  ];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    const { version, path } = entry;
    if (version === toVersion) return path;

    for (const step of POSTURE_MIGRATION_REGISTRY) {
      if (step.fromVersion === version && !visited.has(step.toVersion)) {
        visited.add(step.toVersion);
        queue.push({ version: step.toVersion, path: [...path, step] });
      }
    }
  }

  return [];
}

/** Mark a version as deprecated with a notice consumers should surface. */
export function deprecateVersion(notice: DeprecationNotice): void {
  DEPRECATED_POSTURE_VERSIONS.set(notice.version, notice);
}

/** Migrate an MCP Posture document to a target schema version. */
export function migrateMCPPosture(
  data: Record<string, unknown>,
  targetVersion?: string,
): MigrationResult {
  const fromVersion = String(data.posture_version ?? 'unknown');
  const target = targetVersion ?? LATEST_POSTURE_VERSION;

  if (fromVersion === target) {
    return {
      success: true,
      fromVersion,
      toVersion: target,
      data,
      stepsApplied: [],
      warnings: [],
      errors: [],
    };
  }

  const path = getMigrationPath(fromVersion, target);
  if (path.length === 0) {
    return {
      success: false,
      fromVersion,
      toVersion: target,
      data,
      stepsApplied: [],
      warnings: [],
      errors: [`No migration path from ${fromVersion} to ${target}`],
    };
  }

  let current = { ...data };
  const warnings: string[] = [];
  const applied: MigrationStep[] = [];

  for (const step of path) {
    if (step.breaking) {
      warnings.push(
        `Breaking migration: ${step.fromVersion} → ${step.toVersion}: ${step.description}`,
      );
    }
    try {
      current = step.migrate(current);
      applied.push(step);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        fromVersion,
        toVersion: target,
        data: current,
        stepsApplied: applied,
        warnings,
        errors: [`Migration failed at step ${step.fromVersion} → ${step.toVersion}: ${message}`],
      };
    }
  }

  return {
    success: true,
    fromVersion,
    toVersion: target,
    data: current,
    stepsApplied: applied,
    warnings,
    errors: [],
  };
}

/** Detect deprecation notices for a given version string. */
export function detectVersionWarnings(version: string): DeprecationNotice[] {
  const notices: DeprecationNotice[] = [];
  const notice = DEPRECATED_POSTURE_VERSIONS.get(version);
  if (notice) {
    notices.push(notice);
  } else if (!SUPPORTED_POSTURE_VERSIONS.includes(version)) {
    notices.push({
      version,
      message: `MCP Posture version ${version} is not in the supported set (${SUPPORTED_POSTURE_VERSIONS.join(', ')})`,
      severity: 'warn',
    });
  }
  return notices;
}

/** Validate an MCP Posture document and return version-aware diagnostics. */
export function validateMCPPostureWithVersioning(data: unknown): VersionedValidationResult {
  const raw = data as Record<string, unknown> | null;
  const version = (raw?.posture_version as string | undefined) ?? null;
  const versionWarnings = detectVersionWarnings(version ?? 'unknown');

  const baseResult = validateMCPPosture(data);

  return {
    ...baseResult,
    version_warnings: versionWarnings,
    detected_version: version,
  };
}

// --- Continuous Trust Monitoring ---

/** Severity levels for posture trust monitoring events. */
export type PostureEventSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** Categories of posture trust events produced by drift monitoring. */
export type PostureEventCategory =
  | 'server_added'
  | 'server_removed'
  | 'tool_added'
  | 'tool_removed'
  | 'permission_escalation'
  | 'permission_reduction'
  | 'risk_category_added'
  | 'risk_category_removed'
  | 'risk_finding_introduced'
  | 'risk_finding_resolved'
  | 'risk_finding_escalated'
  | 'scope_expanded'
  | 'scope_restricted';

/** A single posture trust event produced by continuous monitoring. */
export interface PostureTrustEvent {
  /** Machine-readable event category. */
  category: PostureEventCategory;
  /** Severity of the event. */
  severity: PostureEventSeverity;
  /** Human-readable description. */
  description: string;
  /** The affected entity (server_id, tool_id, finding_id, or scope). */
  subject: string;
  /** ISO 8601 timestamp when the event was detected. */
  detected_at: string;
}

/** A posture drift alert groups events produced by comparing two MCP Posture snapshots. */
export interface PostureDriftAlert {
  /** The agent_id of the monitored agent. */
  agent_id: string;
  /** ISO 8601 timestamp of the baseline snapshot. */
  baseline_at: string;
  /** ISO 8601 timestamp of the current snapshot. */
  current_at: string;
  /** Trust events produced by drift analysis. */
  events: PostureTrustEvent[];
  /** Whether this alert contains any high or critical events. */
  hasHighSeverity(): boolean;
  /** Whether this alert is empty (no events). */
  isEmpty(): boolean;
}

/** Create a PostureDriftAlert with computed helper methods. */
export function createPostureDriftAlert(
  partial: Omit<PostureDriftAlert, 'hasHighSeverity' | 'isEmpty'>,
): PostureDriftAlert {
  const hasHighSeverity = (): boolean =>
    partial.events.some((e) => e.severity === 'high' || e.severity === 'critical');
  const isEmpty = (): boolean => partial.events.length === 0;
  return { ...partial, hasHighSeverity, isEmpty };
}

/** Severity for a posture tool based on its risk severity and risk categories. */
function postureToolEventSeverity(tool: ToolEntry): PostureEventSeverity {
  const criticalCats = [
    'command_execution',
    'credential_access',
    'exfiltration',
    'privilege_escalation',
  ];
  const hasCriticalCat = tool.risk_categories.some((c) => criticalCats.includes(c));
  if (tool.risk_severity === 'critical' || hasCriticalCat) return 'critical';
  if (tool.risk_severity === 'high') return 'high';
  return 'medium';
}

/** Severity for a risk finding based on its severity field. */
function postureRiskEventSeverity(severity: string): PostureEventSeverity {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Classify posture trust events from a PostureDiff for continuous monitoring.
 *
 * Analyzes the diff between two posture snapshots and produces a `PostureDriftAlert`
 * containing events for server changes, tool additions/removals, permission changes,
 * risk finding changes, and scope expansions.
 */
export function classifyPostureDriftEvents(
  diff: PostureDiff,
  agentId: string,
  baselineAt: string,
  currentAt: string,
): PostureDriftAlert {
  const now = new Date().toISOString();
  const events: PostureTrustEvent[] = [];

  // Server additions and removals
  for (const serverId of diff.servers.added) {
    events.push({
      category: 'server_added',
      severity: 'high',
      description: `MCP server "${serverId}" added to agent trust boundary`,
      subject: serverId,
      detected_at: now,
    });
  }
  for (const serverId of diff.servers.removed) {
    events.push({
      category: 'server_removed',
      severity: 'info',
      description: `MCP server "${serverId}" removed from agent trust boundary`,
      subject: serverId,
      detected_at: now,
    });
  }

  // Tool additions and removals
  for (const { server_id, tool } of diff.tools.added) {
    events.push({
      category: 'tool_added',
      severity: postureToolEventSeverity(tool),
      description: `Tool "${tool.tool_name}" (${tool.tool_id}) added on server ${server_id}`,
      subject: tool.tool_id,
      detected_at: now,
    });
  }
  for (const { server_id, tool } of diff.tools.removed) {
    events.push({
      category: 'tool_removed',
      severity: 'info',
      description: `Tool "${tool.tool_name}" (${tool.tool_id}) removed from server ${server_id}`,
      subject: tool.tool_id,
      detected_at: now,
    });
  }

  // Tool permission and risk_category changes
  for (const mod of diff.tools.modified) {
    if (mod.field === 'permissions') {
      if (mod.new) {
        events.push({
          category: 'permission_escalation',
          severity: 'high',
          description: `Permission "${mod.new}" added to tool ${mod.tool_id} on ${mod.server_id}`,
          subject: mod.tool_id,
          detected_at: now,
        });
      } else if (mod.old) {
        events.push({
          category: 'permission_reduction',
          severity: 'info',
          description: `Permission "${mod.old}" removed from tool ${mod.tool_id} on ${mod.server_id}`,
          subject: mod.tool_id,
          detected_at: now,
        });
      }
    } else if (mod.field === 'risk_category') {
      if (mod.new) {
        events.push({
          category: 'risk_category_added',
          severity: 'medium',
          description: `Risk category "${mod.new}" added to tool ${mod.tool_id} on ${mod.server_id}`,
          subject: mod.tool_id,
          detected_at: now,
        });
      } else if (mod.old) {
        events.push({
          category: 'risk_category_removed',
          severity: 'info',
          description: `Risk category "${mod.old}" removed from tool ${mod.tool_id} on ${mod.server_id}`,
          subject: mod.tool_id,
          detected_at: now,
        });
      }
    }
  }

  // Risk finding changes
  for (const risk of diff.risks.added) {
    events.push({
      category: 'risk_finding_introduced',
      severity: postureRiskEventSeverity(risk.severity),
      description: `New risk finding "${risk.description}" (${risk.severity}/${risk.category})`,
      subject: risk.finding_id,
      detected_at: now,
    });
  }
  for (const risk of diff.risks.removed) {
    events.push({
      category: 'risk_finding_resolved',
      severity: 'info',
      description: `Risk finding "${risk.finding_id}" (${risk.description}) removed`,
      subject: risk.finding_id,
      detected_at: now,
    });
  }
  for (const mod of diff.risks.modified) {
    if (mod.field === 'severity') {
      const severityOrder: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      if ((severityOrder[mod.new] ?? 0) > (severityOrder[mod.old] ?? 0)) {
        events.push({
          category: 'risk_finding_escalated',
          severity: postureRiskEventSeverity(mod.new),
          description: `Risk ${mod.finding_id} severity escalated from ${mod.old} to ${mod.new}`,
          subject: mod.finding_id,
          detected_at: now,
        });
      }
    }
  }

  // Permission scope changes
  for (const scope of diff.permissions.added) {
    events.push({
      category: 'scope_expanded',
      severity: 'high',
      description: `Permission scope "${scope}" granted`,
      subject: scope,
      detected_at: now,
    });
  }
  for (const scope of diff.permissions.removed) {
    events.push({
      category: 'scope_restricted',
      severity: 'info',
      description: `Permission scope "${scope}" removed`,
      subject: scope,
      detected_at: now,
    });
  }

  return createPostureDriftAlert({
    agent_id: agentId,
    baseline_at: baselineAt,
    current_at: currentAt,
    events,
  });
}

/** Format a posture drift alert as a human-readable string for monitoring output. */
export function formatPostureDriftAlert(alert: PostureDriftAlert): string {
  const lines: string[] = [
    `Posture Drift Alert — agent: ${alert.agent_id}`,
    `  Baseline: ${alert.baseline_at} → Current: ${alert.current_at}`,
    `  Events: ${alert.events.length}`,
  ];

  const bySeverity = new Map<PostureEventSeverity, PostureTrustEvent[]>();
  for (const event of alert.events) {
    const group = bySeverity.get(event.severity) ?? [];
    group.push(event);
    bySeverity.set(event.severity, group);
  }

  for (const [severity, events] of bySeverity) {
    lines.push('');
    lines.push(`  [${severity.toUpperCase()}] (${events.length})`);
    for (const event of events) {
      lines.push(`    • ${event.category}: ${event.description}`);
    }
  }

  if (alert.isEmpty()) {
    lines.push('  No drift events.');
  }

  return lines.join('\n');
}
