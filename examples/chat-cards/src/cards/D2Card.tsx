import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

// ── Styles ────────────────────────────────────────────────────────────────────

const CARD_STYLE: CSSProperties = {
  border: "1px solid #bae6fd",
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
  background: "#f0f9ff",
  borderBottom: "1px solid #bae6fd",
  fontSize: "11px",
  fontWeight: 600,
  color: "#0369a1",
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
  border: "1px solid #bae6fd",
  background: "transparent",
  color: "#0369a1",
  fontSize: "10px",
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: "0.04em",
};

const SVG_IFRAME_STYLE: CSSProperties = {
  width: "100%",
  border: "none",
  display: "block",
  overflow: "hidden",
};

const LOADING_STYLE: CSSProperties = {
  padding: "24px 16px",
  textAlign: "center",
  color: "#94a3b8",
  fontSize: "13px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
};

const ERROR_STYLE: CSSProperties = {
  padding: "12px 16px",
  background: "#fef2f2",
  borderTop: "1px solid #fecaca",
  fontSize: "12px",
  color: "#dc2626",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
};

const FALLBACK_PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "12px 16px",
  background: "#f8fafc",
  fontSize: "13px",
  lineHeight: "1.5",
  overflowX: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
  color: "#334155",
};

const FALLBACK_NOTE_STYLE: CSSProperties = {
  padding: "4px 12px 8px",
  fontSize: "11px",
  color: "#94a3b8",
  fontStyle: "italic",
};

const ICON = "🔷";

// ── Download helpers ──────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadD2Source(content: string, meta?: string) {
  const name = meta ? `${meta.replace(/\s+/g, "-")}.d2` : "diagram.d2";
  downloadBlob(new Blob([content], { type: "text/plain" }), name);
}

async function exportSvg(svgString: string, meta?: string) {
  const name = meta ? `${meta.replace(/\s+/g, "-")}.svg` : "diagram.svg";
  // Strip the XML declaration if present so it works as a standalone SVG file
  const clean = svgString.startsWith("<?xml")
    ? svgString.slice(svgString.indexOf("<svg"))
    : svgString;
  downloadBlob(new Blob([clean], { type: "image/svg+xml" }), name);
}

async function exportPng(svgString: string, meta?: string) {
  const name = meta ? `${meta.replace(/\s+/g, "-")}.png` : "diagram.png";

  const clean = svgString.startsWith("<?xml")
    ? svgString.slice(svgString.indexOf("<svg"))
    : svgString;

  const parser = new DOMParser();
  const doc = parser.parseFromString(clean, "image/svg+xml");
  const svgEl = doc.querySelector("svg");
  let svgW = 0, svgH = 0;
  const vb = svgEl?.getAttribute("viewBox");
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    svgW = parts[2] ?? 0;
    svgH = parts[3] ?? 0;
  }
  if (!svgW) svgW = Number(svgEl?.getAttribute("width") ?? 0) || 1200;
  if (!svgH) svgH = Number(svgEl?.getAttribute("height") ?? 0) || 800;

  const scale = 2;
  const exportW = Math.round(svgW * scale);
  const exportH = Math.round(svgH * scale);

  const sized = clean.replace(/<svg([^>]*)>/, `<svg$1 width="${exportW}" height="${exportH}">`);
  const blob = new Blob([sized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = exportW;
      canvas.height = exportH;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, exportW, exportH);
      ctx.drawImage(img, 0, 0, exportW, exportH);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) downloadBlob(pngBlob, name);
        URL.revokeObjectURL(url);
        resolve();
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG load failed"));
    };
    img.src = url;
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface D2CardProps {
  content: string;
  meta?: string;
  /**
   * Async renderer that produces an SVG string from D2 source.
   * Provide this prop to enable live diagram rendering (e.g. via @terrastruct/d2).
   * When omitted, the card shows the raw D2 source with a fallback note.
   */
  onRenderD2?: (content: string) => Promise<string>;
  className?: string;
  style?: CSSProperties;
}

type RenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; svg: string }
  | { status: "error"; message: string };

// ── Component ─────────────────────────────────────────────────────────────────

export function D2Card({ content, meta, onRenderD2, className, style }: D2CardProps) {
  const [state, setState] = useState<RenderState>(
    onRenderD2 ? { status: "loading" } : { status: "idle" }
  );
  // iframe ref for auto-height adjustment
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(300);

  useEffect(() => {
    if (!onRenderD2) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    onRenderD2(content).then(
      (svg) => { if (!cancelled) setState({ status: "ok", svg }); },
      (e: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    );
    return () => { cancelled = true; };
  }, [content, onRenderD2]);

  // Auto-size the iframe to fit SVG content
  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const body = iframe.contentDocument?.body;
      if (body) {
        const h = body.scrollHeight;
        if (h > 0) setIframeHeight(h + 8);
      }
    } catch {
      // cross-origin or not ready yet
    }
  }, []);

  const svgSrcDoc =
    state.status === "ok"
      ? `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#fff;display:flex;justify-content:center;align-items:flex-start;padding:16px}svg{max-width:100%;height:auto;display:block}</style></head><body>${
          state.svg.startsWith("<?xml") ? state.svg.slice(state.svg.indexOf("<svg")) : state.svg
        }</body></html>`
      : null;

  const title = `D2 Diagram${meta ? ` — ${meta}` : ""}`;
  const hasResult = state.status === "ok";

  return (
    <div className={className} style={{ ...CARD_STYLE, ...style }}>
      <div style={HEADER_STYLE}>
        <span>{ICON}</span>
        <span>{title}</span>
        {state.status === "loading" && (
          <span style={{ marginLeft: "auto", fontSize: "10px", color: "#64748b" }}>rendering…</span>
        )}
        {hasResult && (
          <div style={BTN_STYLE}>
            <button style={ACTION_BTN} type="button" onClick={() => downloadD2Source(content, meta)}>
              ↓ .d2
            </button>
            <button style={ACTION_BTN} type="button" onClick={() => exportSvg((state as { svg: string }).svg, meta)}>
              ↓ SVG
            </button>
            <button style={ACTION_BTN} type="button" onClick={() => exportPng((state as { svg: string }).svg, meta)}>
              ↓ PNG
            </button>
          </div>
        )}
        {(state.status === "idle" || state.status === "error") && (
          <div style={BTN_STYLE}>
            <button style={ACTION_BTN} type="button" onClick={() => downloadD2Source(content, meta)}>
              ↓ .d2
            </button>
          </div>
        )}
      </div>

      {state.status === "loading" && (
        <div style={LOADING_STYLE}>
          <span>⟳</span>
          <span>Compiling diagram…</span>
        </div>
      )}

      {/* Render SVG in an iframe to isolate its styles from the host page */}
      {state.status === "ok" && svgSrcDoc && (
        <iframe
          ref={iframeRef}
          srcDoc={svgSrcDoc}
          style={{ ...SVG_IFRAME_STYLE, height: `${iframeHeight}px` }}
          title={title}
          onLoad={handleIframeLoad}
          sandbox="allow-scripts"
        />
      )}

      {(state.status === "idle" || state.status === "error") && (
        <>
          <pre style={FALLBACK_PRE_STYLE}>
            <code>{content}</code>
          </pre>
          {state.status === "error" && <div style={ERROR_STYLE}>⚠ {state.message}</div>}
          {state.status === "idle" && (
            <div style={FALLBACK_NOTE_STYLE}>
              Pass <code>onRenderD2</code> to enable live rendering
            </div>
          )}
        </>
      )}
    </div>
  );
}
