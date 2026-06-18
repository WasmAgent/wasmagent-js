import type { CSSProperties } from "react";
import type { CardBlock } from "@wasmagent/ui-cards";
import { D2Card } from "./D2Card";
import { MarkdownCard } from "./MarkdownCard";

const UNKNOWN_STYLE: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  overflow: "hidden",
  margin: "8px 0",
  background: "#fafafa",
};

const UNKNOWN_HEADER_STYLE: CSSProperties = {
  padding: "6px 12px",
  background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
  fontSize: "11px",
  fontWeight: 600,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const UNKNOWN_PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "12px 16px",
  fontSize: "13px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
  color: "#64748b",
  overflowX: "auto",
};

export interface CardRendererProps {
  card: CardBlock;
  /** Optional D2 WASM renderer — passed through to D2Card. */
  onRenderD2?: (content: string) => Promise<string>;
  className?: string;
  style?: CSSProperties;
}

/** Dispatches rendering to the appropriate card component by card.type. */
export function CardRenderer({ card, onRenderD2, className, style }: CardRendererProps) {
  switch (card.type) {
    case "markdown":
      return <MarkdownCard content={card.content} {...(card.meta !== undefined && { meta: card.meta })} {...(className !== undefined && { className })} {...(style !== undefined && { style })} />;
    case "d2":
      return <D2Card content={card.content} {...(card.meta !== undefined && { meta: card.meta })} {...(onRenderD2 !== undefined && { onRenderD2 })} {...(className !== undefined && { className })} {...(style !== undefined && { style })} />;
    default:
      return (
        <div className={className} style={{ ...UNKNOWN_STYLE, ...style }}>
          <div style={UNKNOWN_HEADER_STYLE}>card:{card.type}{card.meta ? ` — ${card.meta}` : ""}</div>
          <pre style={UNKNOWN_PRE_STYLE}>
            <code>{card.content}</code>
          </pre>
        </div>
      );
  }
}
