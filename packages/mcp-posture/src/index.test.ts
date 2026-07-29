import { describe, expect, it } from 'bun:test';
import { getSchema } from '@wasmagent/protocol';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPostureDriftEvents,
  createPostureDriftAlert,
  diffMCPPosture,
  formatPostureDiff,
  formatPostureDriftAlert,
  inspectMCPPosture,
  RISK_CATEGORIES,
  validateMCPPosture,
} from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_POSTURE = {
  posture_version: '0.1',
  identity: {
    snapshot_id: 'posture-test-001',
    agent_id: 'test-agent-001',
    captured_at: '2026-06-28T00:00:00Z',
  },
  servers: [
    {
      server_id: 'test-server',
      server_name: 'Test Server',
      tools: [
        {
          tool_id: 'test-tool',
          tool_name: 'test_tool',
        },
      ],
    },
  ],
  attestation: { generator: 'test' },
};

describe('validateMCPPosture', () => {
  it('accepts valid MCP Posture', () => {
    const result = validateMCPPosture(VALID_POSTURE);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object root', () => {
    expect(validateMCPPosture(null).valid).toBe(false);
    expect(validateMCPPosture('string').valid).toBe(false);
    expect(validateMCPPosture(42).valid).toBe(false);
    expect(validateMCPPosture([]).valid).toBe(false);
  });

  it('rejects missing posture_version', () => {
    const { posture_version, ...rest } = VALID_POSTURE;
    const result = validateMCPPosture(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('missing required: posture_version');
  });

  it('rejects missing identity', () => {
    const { identity, ...rest } = VALID_POSTURE;
    const result = validateMCPPosture(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('missing required: identity');
  });

  it('rejects missing servers', () => {
    const { servers, ...rest } = VALID_POSTURE;
    const result = validateMCPPosture(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('missing required: servers');
  });

  it('rejects missing attestation', () => {
    const { attestation, ...rest } = VALID_POSTURE;
    const result = validateMCPPosture(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('missing required: attestation');
  });

  it('rejects unknown posture_version', () => {
    const result = validateMCPPosture({ ...VALID_POSTURE, posture_version: '99.0' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('posture_version must be "0.1"');
  });

  describe('identity object', () => {
    it('requires snapshot_id', () => {
      const posture = {
        ...VALID_POSTURE,
        identity: { agent_id: 'test-agent', captured_at: '2026-06-28T00:00:00Z' },
      };
      const result = validateMCPPosture(posture);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('identity: missing snapshot_id');
    });

    it('requires agent_id', () => {
      const posture = {
        ...VALID_POSTURE,
        identity: { snapshot_id: 'snap-001', captured_at: '2026-06-28T00:00:00Z' },
      };
      const result = validateMCPPosture(posture);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('identity: missing agent_id');
    });

    it('requires captured_at', () => {
      const posture = {
        ...VALID_POSTURE,
        identity: { snapshot_id: 'snap-001', agent_id: 'test-agent' },
      };
      const result = validateMCPPosture(posture);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('identity: missing captured_at');
    });
  });
});

describe('schema risk categories', () => {
  it('includes all 8 risk categories from the taxonomy (7 original + mcp_header_leakage)', () => {
    const schema = getSchema('mcp-posture');

    const toolRiskCategories =
      (schema.properties?.servers?.items?.properties?.tools?.items?.properties?.risk_categories
        ?.items?.enum as string[]) ?? [];
    for (const cat of RISK_CATEGORIES) {
      expect(toolRiskCategories).toContain(cat);
    }
    expect(toolRiskCategories).toHaveLength(8);
  });

  it('risk_summary.category also has all 8 risk categories in the enum', () => {
    const schema = getSchema('mcp-posture');

    const summaryCategoryEnum =
      (schema.properties?.risk_summary?.items?.properties?.category?.enum as string[]) ?? [];
    for (const cat of RISK_CATEGORIES) {
      expect(summaryCategoryEnum).toContain(cat);
    }
    expect(summaryCategoryEnum).toHaveLength(8);
  });

  it('RISK_CATEGORIES export includes mcp_header_leakage', () => {
    expect(RISK_CATEGORIES).toContain('mcp_header_leakage');
  });
});

describe('schema covers MCP 2026-07-28 fields', () => {
  it('schema has protocol_version field', () => {
    const schema = getSchema('mcp-posture');
    expect(schema.properties).toHaveProperty('protocol_version');
  });

  it('schema has session_model on servers items', () => {
    const schema = getSchema('mcp-posture');
    const serverProps = schema.properties?.servers?.items?.properties;
    expect(serverProps).toHaveProperty('session_model');
    expect(serverProps.session_model.enum).toContain('stateless-handle');
  });

  it('schema has handle_expiry_policy on servers items', () => {
    const schema = getSchema('mcp-posture');
    const serverProps = schema.properties?.servers?.items?.properties;
    expect(serverProps).toHaveProperty('handle_expiry_policy');
  });

  it('schema has attestation.auth with OAuth fields', () => {
    const schema = getSchema('mcp-posture');
    const authProps = schema.properties?.attestation?.properties?.auth?.properties;
    expect(authProps).toHaveProperty('audience_bound_token_validated');
    expect(authProps).toHaveProperty('pkce_used');
    expect(authProps).toHaveProperty('per_client_consent_verified');
  });

  it('schema has owasp_agentic_ref on risk_summary items', () => {
    const schema = getSchema('mcp-posture');
    const riskProps = schema.properties?.risk_summary?.items?.properties;
    expect(riskProps).toHaveProperty('owasp_agentic_ref');
  });

  it('posture with stateless-handle session_model is still valid', () => {
    const posture = {
      ...VALID_POSTURE,
      protocol_version: '2026-07-28',
      servers: [
        {
          server_id: 'stateless-server',
          server_name: 'Stateless MCP Server',
          session_model: 'stateless-handle',
          handle_expiry_policy: 'short-lived',
          tools: [{ tool_id: 't1', tool_name: 'tool_one' }],
        },
      ],
      attestation: {
        generator: 'test',
        auth: {
          audience_bound_token_validated: true,
          pkce_used: true,
          per_client_consent_verified: false,
        },
      },
    };
    const result = validateMCPPosture(posture);
    expect(result.valid).toBe(true);
  });
});

describe('verification_endpoint field', () => {
  it('accepts valid HTTPS verification_endpoint', () => {
    const posture = {
      ...VALID_POSTURE,
      verification_endpoint: 'https://verification.trust.example.com/posture/check',
    };
    const result = validateMCPPosture(posture);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts posture without verification_endpoint (optional)', () => {
    const result = validateMCPPosture(VALID_POSTURE);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects HTTP verification_endpoint', () => {
    const posture = {
      ...VALID_POSTURE,
      verification_endpoint: 'http://verification.trust.example.com/posture/check',
    };
    const result = validateMCPPosture(posture);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('verification_endpoint must use HTTPS scheme');
  });

  it('rejects malformed URL verification_endpoint', () => {
    const posture = {
      ...VALID_POSTURE,
      verification_endpoint: 'not-a-url',
    };
    const result = validateMCPPosture(posture);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('verification_endpoint'))).toBe(true);
  });

  it('rejects empty string verification_endpoint', () => {
    const posture = {
      ...VALID_POSTURE,
      verification_endpoint: '',
    };
    const result = validateMCPPosture(posture);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('verification_endpoint'))).toBe(true);
  });
});

describe('schema has verification_endpoint field', () => {
  it('schema includes verification_endpoint as an optional string property', () => {
    const schema = getSchema('mcp-posture');
    expect(schema.properties).toHaveProperty('verification_endpoint');
    const prop = schema.properties.verification_endpoint;
    expect(prop.type).toBe('string');
    expect(prop.format).toBe('uri');
    expect(prop.pattern).toBe('^https://.+');
    expect(schema.required).not.toContain('verification_endpoint');
  });
});

describe('schema covers all fields from posture-model-v0.1.md', () => {
  it('has top-level fields: identity, servers, permission_graph, risk_summary, drift, attestation', () => {
    const schema = getSchema('mcp-posture');

    const props = schema.properties;
    expect(props).toHaveProperty('identity');
    expect(props).toHaveProperty('servers');
    expect(props).toHaveProperty('permission_graph');
    expect(props).toHaveProperty('risk_summary');
    expect(props).toHaveProperty('drift');
    expect(props).toHaveProperty('attestation');
  });

  it('requires posture_version, identity, servers, and attestation', () => {
    const schema = getSchema('mcp-posture');

    const required = schema.required as string[];
    expect(required).toContain('posture_version');
    expect(required).toContain('identity');
    expect(required).toContain('servers');
    expect(required).toContain('attestation');
  });
});

describe('example file validation', () => {
  const examplePath = join(__dirname, '../../../examples/mcp-risk-demo/posture.json');
  interface ExampleTool {
    risk_severity?: string;
  }
  interface ExampleServer {
    tools?: ExampleTool[];
  }
  let exampleData: {
    servers: ExampleServer[];
    permission_graph?: Record<string, unknown>;
    risk_summary?: unknown[];
  };

  function loadExample() {
    const raw = readFileSync(examplePath, 'utf-8');
    exampleData = JSON.parse(raw);
  }

  it('validates examples/mcp-risk-demo/posture.json', () => {
    loadExample();
    const result = validateMCPPosture(exampleData);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('has at least 2 MCP servers', () => {
    loadExample();
    expect(exampleData.servers.length).toBeGreaterThanOrEqual(2);
  });

  it('has at least one tool with high risk severity', () => {
    loadExample();
    const highRiskTools = exampleData.servers.flatMap(
      (server) => server.tools?.filter((t) => t.risk_severity === 'high') ?? [],
    );
    expect(highRiskTools.length).toBeGreaterThanOrEqual(1);
  });

  it('includes a non-empty permission_graph', () => {
    loadExample();
    expect(exampleData.permission_graph).toBeDefined();
    expect(exampleData.permission_graph).not.toEqual({});
  });

  it('includes at least 2 risk_summary entries', () => {
    loadExample();
    expect(exampleData.risk_summary?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('inspectMCPPosture', () => {
  it('produces human-readable output', () => {
    const output = inspectMCPPosture(VALID_POSTURE);
    expect(output).toContain('MCP Posture v0.1');
    expect(output).toContain('posture-test-001');
    expect(output).toContain('test-agent-001');
    expect(output).toContain('Servers:');
  });

  it('shows protocol_version in output', () => {
    const posture = { ...VALID_POSTURE, protocol_version: '2026-07-28' };
    const output = inspectMCPPosture(posture);
    expect(output).toContain('2026-07-28');
  });

  it('shows owasp_agentic_ref in critical finding output', () => {
    const posture = {
      ...VALID_POSTURE,
      risk_summary: [
        {
          finding_id: 'f-001',
          severity: 'critical',
          category: 'prompt_injection',
          description: 'Tool poisoning detected',
          owasp_agentic_ref: 'ASI01',
        },
      ],
    };
    const output = inspectMCPPosture(posture);
    expect(output).toContain('ASI01');
  });
});

describe('diffMCPPosture', () => {
  it('returns empty diff for identical posture snapshots', () => {
    const diff = diffMCPPosture(VALID_POSTURE, { ...VALID_POSTURE });
    expect(diff.isEmpty()).toBe(true);
  });

  it('detects added servers', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        ...VALID_POSTURE.servers,
        {
          server_id: 'new-server',
          server_name: 'New Server',
          tools: [],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    expect(diff.isEmpty()).toBe(false);
    expect(diff.servers.added).toContain('new-server');
  });

  it('detects removed servers', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    expect(diff.isEmpty()).toBe(false);
    expect(diff.servers.removed).toContain('test-server');
  });

  it('detects added and removed tools', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'new-tool',
              tool_name: 'new_tool',
              permissions: ['fs:read'],
              risk_categories: ['credential_access'],
              risk_severity: 'medium',
            },
          ],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    expect(diff.tools.added).toHaveLength(1);
    expect(diff.tools.added[0].tool.tool_id).toBe('new-tool');
    expect(diff.tools.removed).toHaveLength(1);
    expect(diff.tools.removed[0].tool.tool_id).toBe('test-tool');
  });

  it('detects permission changes', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      permission_graph: {
        permission_scopes: ['network:outbound'],
      },
    };
    const newPosture = {
      ...VALID_POSTURE,
      permission_graph: {
        permission_scopes: ['network:outbound', 'fs:read'],
      },
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    expect(diff.permissions.added).toContain('fs:read');
  });

  it('detects risk findings added, removed, and modified', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        { finding_id: 'f-001', severity: 'low', category: 'ssrf', description: 'Old finding' },
      ],
    };
    const newPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        { finding_id: 'f-001', severity: 'high', category: 'ssrf', description: 'Old finding' },
        {
          finding_id: 'f-002',
          severity: 'medium',
          category: 'exfiltration',
          description: 'New finding',
        },
      ],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    expect(diff.risks.modified).toHaveLength(1);
    expect(diff.risks.modified[0].finding_id).toBe('f-001');
    expect(diff.risks.modified[0].field).toBe('severity');
    expect(diff.risks.modified[0].old).toBe('low');
    expect(diff.risks.modified[0].new).toBe('high');
    expect(diff.risks.added).toHaveLength(1);
    expect(diff.risks.added[0].finding_id).toBe('f-002');
  });
});

describe('formatPostureDiff', () => {
  it('produces human-readable diff output', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'test-tool',
              tool_name: 'test_tool',
              permissions: ['network:outbound'],
              risk_categories: ['ssrf'],
              risk_severity: 'low',
            },
          ],
        },
        {
          server_id: 'added-server',
          server_name: 'Added Server',
          tools: [],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const output = formatPostureDiff(diff);
    expect(output).toContain('Servers added');
    expect(output).toContain('added-server');
  });

  it('reports no differences for empty diff', () => {
    const diff = diffMCPPosture(VALID_POSTURE, { ...VALID_POSTURE });
    const output = formatPostureDiff(diff);
    expect(output).toContain('No differences found');
  });
});

describe('diff with example drift fixtures', () => {
  const oldPath = join(__dirname, '../../../examples/mcp-risk-demo/posture-old.json');
  const newPath = join(__dirname, '../../../examples/mcp-risk-demo/posture-new.json');
  let oldData: Record<string, unknown>;
  let newData: Record<string, unknown>;

  it('diff detects server addition (local-filesystem)', () => {
    oldData = JSON.parse(readFileSync(oldPath, 'utf-8'));
    newData = JSON.parse(readFileSync(newPath, 'utf-8'));
    const diff = diffMCPPosture(oldData, newData);
    expect(diff.servers.added).toContain('local-filesystem');
  });

  it('diff detects tool additions', () => {
    const diff = diffMCPPosture(oldData, newData);
    const addedToolIds = diff.tools.added.map((t) => t.tool.tool_id);
    expect(addedToolIds).toContain('create-issue');
    expect(addedToolIds).toContain('read-file');
    expect(addedToolIds).toContain('write-file');
  });

  it('diff detects permission expansion', () => {
    const diff = diffMCPPosture(oldData, newData);
    expect(diff.permissions.added).toContain('fs:read');
    expect(diff.permissions.added).toContain('fs:write');
  });

  it('diff is not empty', () => {
    const diff = diffMCPPosture(oldData, newData);
    expect(diff.isEmpty()).toBe(false);
  });
});

// --- Continuous Trust Monitoring tests ---

describe('createPostureDriftAlert', () => {
  it('creates an alert with computed hasHighSeverity and isEmpty', () => {
    const alert = createPostureDriftAlert({
      agent_id: 'agent-1',
      baseline_at: '2026-01-01T00:00:00Z',
      current_at: '2026-01-02T00:00:00Z',
      events: [
        {
          category: 'server_added',
          severity: 'high',
          description: 'Server added',
          subject: 'srv-1',
          detected_at: '2026-01-02T00:00:00Z',
        },
      ],
    });
    expect(alert.agent_id).toBe('agent-1');
    expect(alert.isEmpty()).toBe(false);
    expect(alert.hasHighSeverity()).toBe(true);
  });

  it('isEmpty returns true for empty events', () => {
    const alert = createPostureDriftAlert({
      agent_id: 'agent-1',
      baseline_at: '2026-01-01T00:00:00Z',
      current_at: '2026-01-02T00:00:00Z',
      events: [],
    });
    expect(alert.isEmpty()).toBe(true);
  });

  it('hasHighSeverity returns true when a critical event exists', () => {
    const alert = createPostureDriftAlert({
      agent_id: 'agent-1',
      baseline_at: '2026-01-01T00:00:00Z',
      current_at: '2026-01-02T00:00:00Z',
      events: [
        {
          category: 'risk_finding_introduced',
          severity: 'critical',
          description: 'Critical finding',
          subject: 'f-001',
          detected_at: '2026-01-02T00:00:00Z',
        },
      ],
    });
    expect(alert.hasHighSeverity()).toBe(true);
  });
});

describe('classifyPostureDriftEvents', () => {
  it('produces empty alert for identical posture snapshots', () => {
    const diff = diffMCPPosture(VALID_POSTURE, { ...VALID_POSTURE });
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    expect(alert.isEmpty()).toBe(true);
    expect(alert.hasHighSeverity()).toBe(false);
  });

  it('classifies server_added events as high severity', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        ...VALID_POSTURE.servers,
        {
          server_id: 'new-server',
          server_name: 'New Server',
          tools: [],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    expect(alert.isEmpty()).toBe(false);
    const serverEvents = alert.events.filter((e) => e.category === 'server_added');
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0].severity).toBe('high');
    expect(serverEvents[0].subject).toBe('new-server');
  });

  it('classifies server_removed events as info', () => {
    const newPosture = { ...VALID_POSTURE, servers: [] };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const removedEvents = alert.events.filter((e) => e.category === 'server_removed');
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0].severity).toBe('info');
    expect(removedEvents[0].subject).toBe('test-server');
  });

  it('classifies tool_added with critical severity for tools with critical risk categories', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'new-tool',
              tool_name: 'dangerous_tool',
              permissions: ['fs:write'],
              risk_categories: ['command_execution', 'credential_access'],
              risk_severity: 'critical',
            },
          ],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const toolAddedEvents = alert.events.filter(
      (e) => e.category === 'tool_added' && e.severity === 'critical',
    );
    expect(toolAddedEvents).toHaveLength(1);
    expect(toolAddedEvents[0].subject).toBe('new-tool');
  });

  it('classifies tool_removed events as info', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const removedToolEvents = alert.events.filter((e) => e.category === 'tool_removed');
    expect(removedToolEvents).toHaveLength(1);
    expect(removedToolEvents[0].severity).toBe('info');
  });

  it('classifies permission_escalation events as high', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: ['fs:read'],
              risk_categories: [],
              risk_severity: 'low',
            },
          ],
        },
      ],
    };
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: ['fs:read', 'fs:write'],
              risk_categories: [],
              risk_severity: 'low',
            },
          ],
        },
      ],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const escalationEvents = alert.events.filter((e) => e.category === 'permission_escalation');
    expect(escalationEvents).toHaveLength(1);
    expect(escalationEvents[0].severity).toBe('high');
    expect(escalationEvents[0].subject).toBe('existing-tool');
  });

  it('classifies permission_reduction events as info', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: ['fs:read'],
              risk_categories: [],
              risk_severity: 'low',
            },
          ],
        },
      ],
    };
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: [],
              risk_categories: [],
              risk_severity: 'low',
            },
          ],
        },
      ],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const reductionEvents = alert.events.filter((e) => e.category === 'permission_reduction');
    expect(reductionEvents).toHaveLength(1);
    expect(reductionEvents[0].severity).toBe('info');
  });

  it('classifies risk_category_added events as medium', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: [],
              risk_categories: [],
              risk_severity: 'low',
            },
          ],
        },
      ],
    };
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: [],
              risk_categories: ['ssrf'],
              risk_severity: 'low',
            },
          ],
        },
      ],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const catAddedEvents = alert.events.filter((e) => e.category === 'risk_category_added');
    expect(catAddedEvents).toHaveLength(1);
    expect(catAddedEvents[0].severity).toBe('medium');
  });

  it('classifies risk_finding_introduced events with matching severity', () => {
    const newPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        {
          finding_id: 'f-001',
          severity: 'critical',
          category: 'exfiltration',
          description: 'Data exfiltration risk',
        },
      ],
    };
    const oldPosture = {
      ...VALID_POSTURE,
      risk_summary: [],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const findingEvents = alert.events.filter((e) => e.category === 'risk_finding_introduced');
    expect(findingEvents).toHaveLength(1);
    expect(findingEvents[0].severity).toBe('critical');
    expect(findingEvents[0].subject).toBe('f-001');
  });

  it('classifies risk_finding_resolved events as info', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        { finding_id: 'f-001', severity: 'high', category: 'ssrf', description: 'Old finding' },
      ],
    };
    const newPosture = { ...VALID_POSTURE, risk_summary: [] };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const resolvedEvents = alert.events.filter((e) => e.category === 'risk_finding_resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0].severity).toBe('info');
  });

  it('classifies risk_finding_escalated when severity increases', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        { finding_id: 'f-001', severity: 'low', category: 'ssrf', description: 'Low finding' },
      ],
    };
    const newPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        { finding_id: 'f-001', severity: 'critical', category: 'ssrf', description: 'Low finding' },
      ],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const escalatedEvents = alert.events.filter((e) => e.category === 'risk_finding_escalated');
    expect(escalatedEvents).toHaveLength(1);
    expect(escalatedEvents[0].severity).toBe('critical');
    expect(escalatedEvents[0].description).toContain('low');
    expect(escalatedEvents[0].description).toContain('critical');
  });

  it('does not classify risk_finding_escalated when severity decreases', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        { finding_id: 'f-001', severity: 'critical', category: 'ssrf', description: 'Finding' },
      ],
    };
    const newPosture = {
      ...VALID_POSTURE,
      risk_summary: [
        { finding_id: 'f-001', severity: 'low', category: 'ssrf', description: 'Finding' },
      ],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const escalatedEvents = alert.events.filter((e) => e.category === 'risk_finding_escalated');
    expect(escalatedEvents).toHaveLength(0);
  });

  it('classifies scope_expanded events as high', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      permission_graph: { permission_scopes: ['network:outbound'] },
    };
    const newPosture = {
      ...VALID_POSTURE,
      permission_graph: { permission_scopes: ['network:outbound', 'fs:read'] },
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const expandedEvents = alert.events.filter((e) => e.category === 'scope_expanded');
    expect(expandedEvents).toHaveLength(1);
    expect(expandedEvents[0].severity).toBe('high');
    expect(expandedEvents[0].subject).toBe('fs:read');
  });

  it('classifies scope_restricted events as info', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      permission_graph: { permission_scopes: ['network:outbound', 'fs:read'] },
    };
    const newPosture = {
      ...VALID_POSTURE,
      permission_graph: { permission_scopes: ['network:outbound'] },
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const restrictedEvents = alert.events.filter((e) => e.category === 'scope_restricted');
    expect(restrictedEvents).toHaveLength(1);
    expect(restrictedEvents[0].severity).toBe('info');
  });

  it('populates agent_id and timestamps on the alert', () => {
    const diff = diffMCPPosture(VALID_POSTURE, { ...VALID_POSTURE });
    const alert = classifyPostureDriftEvents(
      diff,
      'my-agent',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    expect(alert.agent_id).toBe('my-agent');
    expect(alert.baseline_at).toBe('2026-01-01T00:00:00Z');
    expect(alert.current_at).toBe('2026-01-02T00:00:00Z');
  });

  it('each event has an ISO 8601 detected_at timestamp', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'added-srv',
          server_name: 'Added Server',
          tools: [],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    for (const event of alert.events) {
      expect(event.detected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('detects multiple event types in a single diff', () => {
    const oldPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: ['fs:read'],
              risk_categories: [],
              risk_severity: 'low',
            },
          ],
        },
      ],
      permission_graph: { permission_scopes: ['fs:read'] },
      risk_summary: [],
    };
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'test-server',
          server_name: 'Test Server',
          tools: [
            {
              tool_id: 'existing-tool',
              tool_name: 'existing',
              permissions: ['fs:read', 'fs:write'],
              risk_categories: ['ssrf'],
              risk_severity: 'low',
            },
          ],
        },
        {
          server_id: 'new-srv',
          server_name: 'New Server',
          tools: [],
        },
      ],
      permission_graph: { permission_scopes: ['fs:read', 'fs:write', 'network:outbound'] },
      risk_summary: [
        {
          finding_id: 'f-001',
          severity: 'high',
          category: 'exfiltration',
          description: 'New finding',
        },
      ],
    };
    const diff = diffMCPPosture(oldPosture, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const categories = new Set(alert.events.map((e) => e.category));
    expect(categories.has('server_added')).toBe(true);
    expect(categories.has('permission_escalation')).toBe(true);
    expect(categories.has('risk_category_added')).toBe(true);
    expect(categories.has('risk_finding_introduced')).toBe(true);
    expect(categories.has('scope_expanded')).toBe(true);
    expect(alert.hasHighSeverity()).toBe(true);
  });
});

describe('formatPostureDriftAlert', () => {
  it('formats empty alert with no drift message', () => {
    const alert = classifyPostureDriftEvents(
      diffMCPPosture(VALID_POSTURE, { ...VALID_POSTURE }),
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const output = formatPostureDriftAlert(alert);
    expect(output).toContain('agent-1');
    expect(output).toContain('No drift events');
  });

  it('includes agent_id and timestamps in output', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'new-srv',
          server_name: 'New Server',
          tools: [],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const output = formatPostureDriftAlert(alert);
    expect(output).toContain('agent-1');
    expect(output).toContain('2026-01-01T00:00:00Z');
    expect(output).toContain('2026-01-02T00:00:00Z');
  });

  it('groups events by severity', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'new-srv',
          server_name: 'New Server',
          tools: [
            {
              tool_id: 'critical-tool',
              tool_name: 'critical',
              permissions: ['fs:write'],
              risk_categories: ['privilege_escalation'],
              risk_severity: 'critical',
            },
          ],
        },
      ],
      permission_graph: { permission_scopes: ['network:outbound'] },
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const output = formatPostureDriftAlert(alert);
    expect(output).toContain('[CRITICAL]');
    expect(output).toContain('[HIGH]');
    expect(output).toContain('Events:');
  });

  it('includes event category and description in output', () => {
    const newPosture = {
      ...VALID_POSTURE,
      servers: [
        {
          server_id: 'new-srv',
          server_name: 'New Server',
          tools: [],
        },
      ],
    };
    const diff = diffMCPPosture(VALID_POSTURE, newPosture);
    const alert = classifyPostureDriftEvents(
      diff,
      'agent-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    const output = formatPostureDriftAlert(alert);
    expect(output).toContain('server_added');
    expect(output).toContain('new-srv');
  });
});
