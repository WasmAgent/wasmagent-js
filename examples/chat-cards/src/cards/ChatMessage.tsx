import type { CSSProperties } from "react";
import { useMemo } from "react";
import { parseCardBlocks } from "@agentkit-js/ui-cards";
import type { AgentMessage } from "@agentkit-js/react";
import { CardRenderer } from "./CardRenderer";

const TOOL_BADGE_STYLE: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "4px",
  fontSize: "12px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  color: "#475569",
};

const ERROR_STYLE: CSSProperties = {
  color: "#dc2626",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: "6px",
  padding: "8px 12px",
  fontSize: "13px",
};

const TEXT_STYLE: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: "14px",
  lineHeight: "1.6",
  color: "#1e293b",
};

export interface ChatMessageProps {
  message: AgentMessage;
  /** Optional D2 WASM renderer — passed to D2Card. */
  onRenderD2?: (content: string) => Promise<string>;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders an AgentMessage, parsing any embedded ```card:* fenced blocks
 * into card components and leaving the remaining text as plain text segments.
 */
export function ChatMessage({ message, onRenderD2, className, style }: ChatMessageProps) {
  const parsed = useMemo(() => parseCardBlocks(message.content), [message.content]);

  if (message.role === "tool") {
    return (
      <div className={className} style={style}>
        <span style={TOOL_BADGE_STYLE}>⚙ {message.content}</span>
      </div>
    );
  }

  if (message.role === "error") {
    return (
      <div className={className} style={{ ...ERROR_STYLE, ...style }}>
        ⚠ {message.content}
      </div>
    );
  }

  return (
    <div className={className} style={style}>
      {parsed.segments.map((seg, i) => {
        if (seg.kind === "card") {
          return (
            <CardRenderer
              key={seg.card.id}
              card={seg.card}
              {...(onRenderD2 !== undefined && { onRenderD2 })}
            />
          );
        }
        return (
          <p key={`text-${i}`} style={{ ...TEXT_STYLE, margin: "4px 0" }}>
            {seg.content}
          </p>
        );
      })}
    </div>
  );
}
