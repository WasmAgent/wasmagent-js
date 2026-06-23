import { useState, useMemo, type CSSProperties } from "react";
import { D2 } from "@terrastruct/d2";
import type { AgentMessage } from "@wasmagent/react";
import { ChatMessage } from "./cards/ChatMessage";
import { parseCardBlocks } from "@wasmagent/ui-cards";

// ── D2 renderer ───────────────────────────────────────────────────────────────

async function renderD2(content: string): Promise<string> {
  // Use a fresh D2 instance per render to avoid Worker message ordering issues
  // in the browser bundle. The D2 WASM init is cached by the Worker internally.
  const d2 = new D2();
  const result = await d2.compile(content);
  return d2.render(result.diagram, { ...result.renderOptions, noXMLTag: true, pad: 32 });
}

// ── Demo fixture messages ─────────────────────────────────────────────────────

const DEMO_MESSAGES: AgentMessage[] = [
  {
    id: "msg-1",
    role: "assistant",
    content: "I've analyzed the data. Here's a summary:",
  },
  {
    id: "msg-2",
    role: "assistant",
    content: `\`\`\`card:markdown
## Data Analysis Report

| Metric | Value | Change |
|--------|-------|--------|
| Total Users | **42,891** | ↑ 12% |
| Active Sessions | **8,204** | ↑ 3% |
| Error Rate | **0.4%** | ↓ 0.1% |

### Key Findings

1. **User growth** is accelerating — up 12% month-over-month
2. The error rate dropped after the \`v2.3.1\` deployment
3. Peak usage is between **14:00–16:00 UTC**

> Overall system health looks good. No immediate action required.
\`\`\``,
  },
  {
    id: "msg-3",
    role: "assistant",
    content: "I also prepared an architecture diagram for the new service:",
  },
  {
    id: "msg-4",
    role: "assistant",
    content: `\`\`\`card:d2 service-topology
direction: right

user: User {
  shape: person
}

api: API Gateway {
  shape: rectangle
}

auth: Auth Service
agent: Agent Runtime
db: PostgreSQL {
  shape: cylinder
}

user -> api: HTTPS
api -> auth: JWT verify
api -> agent: task
agent -> db: read/write
\`\`\``,
  },
  {
    id: "msg-5",
    role: "assistant",
    content: `Let me show you how cards and text can be interleaved.

\`\`\`card:markdown
### Quick Reference

\`\`\`ts
import { parseCardBlocks } from "@wasmagent/ui-cards";

const parsed = parseCardBlocks(aiReplyText);
// → { segments: [...], cards: [...] }
\`\`\`

Cards can contain **nested fences** — they're preserved as content.
\`\`\`

And this text appears after the card. You can keep adding content here.`,
  },
  {
    id: "msg-6",
    role: "tool",
    content: "calculate_metrics: result ready",
    toolName: "calculate_metrics",
  },
  {
    id: "msg-7",
    role: "error",
    content: "Connection timeout — retrying in 3s",
  },
  {
    id: "msg-8",
    role: "assistant",
    content: `Unknown card types degrade gracefully:

\`\`\`card:chart
{
  "type": "bar",
  "data": [10, 20, 30, 40]
}
\`\`\`

The card above renders as a plain code block since no chart renderer is registered yet.`,
  },
];

// ── Styles ────────────────────────────────────────────────────────────────────

const PAGE_STYLE: CSSProperties = {
  minHeight: "100vh",
  background: "#f8fafc",
  display: "flex",
  flexDirection: "column",
};

const HEADER_STYLE: CSSProperties = {
  padding: "16px 24px",
  background: "#ffffff",
  borderBottom: "1px solid #e2e8f0",
  display: "flex",
  alignItems: "center",
  gap: "12px",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  color: "#1e293b",
  margin: 0,
};

const BADGE_STYLE: CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "9999px",
  background: "#e0f2fe",
  color: "#0369a1",
  fontWeight: 600,
};

const MAIN_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  gap: "0",
  maxWidth: "1200px",
  margin: "0 auto",
  width: "100%",
  padding: "24px",
};

const CHAT_PANE_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  minWidth: 0,
};

const SIDEBAR_STYLE: CSSProperties = {
  width: "280px",
  marginLeft: "24px",
  flexShrink: 0,
};

const PANEL_STYLE: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  padding: "16px",
  marginBottom: "16px",
};

const PANEL_TITLE_STYLE: CSSProperties = {
  fontSize: "12px",
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: "10px",
};

const SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: "10px",
  fontWeight: 600,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  padding: "0 4px",
  marginBottom: "4px",
};

const MSG_WRAPPER_STYLE: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  padding: "14px 16px",
};

const ROLE_CHIP_STYLE: CSSProperties = {
  display: "inline-block",
  fontSize: "10px",
  fontWeight: 600,
  padding: "2px 6px",
  borderRadius: "4px",
  marginBottom: "8px",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

function roleChipStyle(role: string): CSSProperties {
  const colors: Record<string, { bg: string; color: string }> = {
    assistant: { bg: "#f0fdf4", color: "#15803d" },
    tool: { bg: "#f1f5f9", color: "#475569" },
    error: { bg: "#fef2f2", color: "#dc2626" },
  };
  const c = colors[role] ?? colors["assistant"];
  return { ...ROLE_CHIP_STYLE, background: c!.bg, color: c!.color };
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedMsg = DEMO_MESSAGES.find((m) => m.id === selected);

  return (
    <div style={PAGE_STYLE}>
      <header style={HEADER_STYLE}>
        <h1 style={TITLE_STYLE}>WasmAgent Chat Cards Demo</h1>
        <span style={BADGE_STYLE}>@wasmagent/react</span>
      </header>

      <main style={MAIN_STYLE}>
        <div style={CHAT_PANE_STYLE}>
          <div style={SECTION_LABEL_STYLE}>Conversation</div>
          {DEMO_MESSAGES.map((msg) => (
            <div
              key={msg.id}
              onClick={() => setSelected(selected === msg.id ? null : msg.id)}
              style={{
                ...MSG_WRAPPER_STYLE,
                cursor: "pointer",
                outline: selected === msg.id ? "2px solid #3b82f6" : "none",
                outlineOffset: "2px",
              }}
            >
              <div style={roleChipStyle(msg.role)}>{msg.role}</div>
              <ChatMessage message={msg} onRenderD2={renderD2} />
            </div>
          ))}
        </div>

        <aside style={SIDEBAR_STYLE}>
          <div style={PANEL_STYLE}>
            <div style={PANEL_TITLE_STYLE}>How it works</div>
            <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 8px" }}>
              AI replies use <code>```card:type</code> fenced blocks. The{" "}
              <strong>parseCardBlocks()</strong> parser extracts them into typed segments.
            </p>
            <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
              Click any message to see its parsed structure in the panel below.
            </p>
          </div>

          {selectedMsg && (
            <div style={PANEL_STYLE}>
              <div style={PANEL_TITLE_STYLE}>Parsed Segments</div>
              {parseCardBlocks(selectedMsg.content).segments.map((seg, i) => (
                <div
                  key={i}
                  style={{
                    padding: "6px 8px",
                    borderRadius: "5px",
                    marginBottom: "6px",
                    fontSize: "12px",
                    fontFamily: "ui-monospace, monospace",
                    background: seg.kind === "card" ? "#eff6ff" : "#f8fafc",
                    border: `1px solid ${seg.kind === "card" ? "#bfdbfe" : "#e2e8f0"}`,
                    color: seg.kind === "card" ? "#1d4ed8" : "#475569",
                  }}
                >
                  {seg.kind === "card" ? (
                    <>
                      <strong>card:{seg.card.type}</strong>
                      {seg.card.meta && <span> ({seg.card.meta})</span>}
                      <div style={{ color: "#64748b", marginTop: "2px" }}>
                        id: {seg.card.id} · {seg.card.content.split("\n").length} lines
                      </div>
                    </>
                  ) : (
                    <span>text · {seg.content.length} chars</span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={PANEL_STYLE}>
            <div style={PANEL_TITLE_STYLE}>Card Types</div>
            {[
              { type: "markdown", icon: "📄", status: "✓ rendered" },
              { type: "d2", icon: "🔷", status: "✓ WASM rendered" },
              { type: "chart", icon: "📊", status: "→ degraded" },
            ].map((t) => (
              <div
                key={t.type}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "5px 0",
                  fontSize: "13px",
                  borderBottom: "1px solid #f1f5f9",
                }}
              >
                <span>{t.icon}</span>
                <code style={{ color: "#334155" }}>card:{t.type}</code>
                <span style={{ marginLeft: "auto", fontSize: "11px", color: "#94a3b8" }}>
                  {t.status}
                </span>
              </div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}
