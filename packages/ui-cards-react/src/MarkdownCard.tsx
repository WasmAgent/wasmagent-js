import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// react-markdown types are not yet updated for React 19.
// biome-ignore lint/suspicious/noExplicitAny: type compat shim
const Markdown = ReactMarkdown as any;

// ── Styles ────────────────────────────────────────────────────────────────────

const CARD_STYLE: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  overflow: "hidden",
  margin: "8px 0",
  background: "#ffffff",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "6px 12px",
  background: "#f8fafc",
  borderBottom: "1px solid #e2e8f0",
  fontSize: "11px",
  fontWeight: 600,
  color: "#64748b",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  userSelect: "none",
};

const BTN_STYLE: CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  gap: "4px",
};

const ACTION_BTN: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "4px",
  border: "1px solid #e2e8f0",
  background: "transparent",
  color: "#475569",
  fontSize: "10px",
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: "0.04em",
};

const CONTENT_STYLE: CSSProperties = {
  padding: "12px 16px",
  fontSize: "14px",
  lineHeight: "1.6",
  color: "#1e293b",
};

const ICON = "📄";

// ── Download helpers ──────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadMarkdown(content: string, meta?: string) {
  const name = meta ? `${meta.replace(/\s+/g, "-")}.md` : "document.md";
  downloadBlob(new Blob([content], { type: "text/markdown" }), name);
}

/**
 * Export Markdown as .docx by converting it to Word XML.
 *
 * Uses the `docx` library (dynamically imported) to build a proper
 * Word document from parsed Markdown tokens. Supports headings,
 * paragraphs, bold, italic, inline code, and tables.
 */
async function exportDocx(content: string, meta?: string) {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
  } = await import("docx");

  const name = meta ? `${meta.replace(/\s+/g, "-")}.docx` : "document.docx";

  // Simple line-based Markdown → docx paragraph converter.
  // Handles: # headings, **bold**, *italic*, `code`, blank lines, tables.
  const lines = content.split("\n");
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const text =
        headingMatch[2]?.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1") ?? "";
      const headingLevels: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5,
        6: HeadingLevel.HEADING_6,
      };
      children.push(
        new Paragraph({
          heading: headingLevels[level] ?? HeadingLevel.HEADING_1,
          children: [new TextRun(text)],
        })
      );
      i++;
      continue;
    }

    // Table detection: line starts with | and next line is |---|
    if (line.startsWith("|") && lines[i + 1]?.match(/^\|[-| :]+\|$/)) {
      const headerCells = line
        .split("|")
        .filter((c) => c.trim())
        .map((c) => c.trim());
      i += 2; // skip header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i]?.startsWith("|")) {
        const cells =
          lines[i]
            ?.split("|")
            .filter((c) => c.trim())
            .map((c) => c.trim()) ?? [];
        bodyRows.push(cells);
        i++;
      }
      const makeRow = (cells: string[], isHeader = false) =>
        new TableRow({
          children: cells.map(
            (text) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({ text: text.replace(/\*\*(.+?)\*\*/g, "$1"), bold: isHeader }),
                    ],
                  }),
                ],
                width: { size: Math.floor(9000 / Math.max(cells.length, 1)), type: WidthType.DXA },
              })
          ),
        });
      children.push(
        new Table({ rows: [makeRow(headerCells, true), ...bodyRows.map((r) => makeRow(r))] })
      );
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      children.push(new Paragraph({ text: "─────────────────────────────────────" }));
      i++;
      continue;
    }

    // Blank line → empty paragraph (spacing)
    if (!line.trim()) {
      children.push(new Paragraph({}));
      i++;
      continue;
    }

    // Normal paragraph — parse inline bold/italic/code
    const runs: InstanceType<typeof TextRun>[] = [];
    const inlineRe = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|([^*`]+))/g;
    let m: RegExpExecArray | null = inlineRe.exec(line);
    while (m !== null) {
      if (m[2] !== undefined) runs.push(new TextRun({ text: m[2], bold: true }));
      else if (m[3] !== undefined) runs.push(new TextRun({ text: m[3], italics: true }));
      else if (m[4] !== undefined)
        runs.push(new TextRun({ text: m[4], font: "Courier New", size: 18 }));
      else if (m[5] !== undefined) runs.push(new TextRun({ text: m[5] }));
      m = inlineRe.exec(line);
    }
    if (runs.length === 0) runs.push(new TextRun(line));
    children.push(new Paragraph({ children: runs }));
    i++;
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const buffer = await Packer.toBlob(doc);
  downloadBlob(buffer, name);
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface MarkdownCardProps {
  content: string;
  meta?: string;
  className?: string;
  style?: CSSProperties;
  /** Fill parent height — used in full-screen preview panel. */
  fillHeight?: boolean;
}

export function MarkdownCard({ content, meta, className, style, fillHeight }: MarkdownCardProps) {
  const containerStyle: CSSProperties = {
    ...CARD_STYLE,
    ...style,
    ...(fillHeight && {
      display: "flex",
      flexDirection: "column",
      flex: 1,
      height: "100%",
      margin: 0,
      borderRadius: 0,
      border: "none",
    }),
  };
  const contentStyle: CSSProperties = {
    ...CONTENT_STYLE,
    ...(fillHeight && { flex: 1, overflowY: "auto" }),
  };

  return (
    <div className={className} style={containerStyle}>
      <div style={HEADER_STYLE}>
        <span>{ICON}</span>
        <span>{meta ?? "Markdown"}</span>
        <div style={BTN_STYLE}>
          <button style={ACTION_BTN} type="button" onClick={() => downloadMarkdown(content, meta)}>
            ↓ .md
          </button>
          <button style={ACTION_BTN} type="button" onClick={() => exportDocx(content, meta)}>
            ↓ .docx
          </button>
        </div>
      </div>
      <div style={contentStyle}>
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </div>
  );
}
