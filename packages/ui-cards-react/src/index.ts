/**
 * @agentkit-js/ui-cards-react — React components for rendering card blocks.
 *
 * Companion to {@link @agentkit-js/ui-cards} that provides ready-to-use
 * React components:
 *
 * - {@link MarkdownCard} — GFM Markdown with .md/.docx export
 * - {@link D2Card} — D2 diagrams via WASM (fillHeight mode for full-screen
 *   preview), with .d2/.svg/.png export
 * - {@link CardRenderer} — dispatches to the right card type by `card.type`
 * - {@link ChatMessage} — renders a full chat message, parsing card blocks
 *   from message text and interleaving cards with plain-text segments
 *
 * Peer dependencies are mostly optional — install only what you need:
 * - `react@>=18` is required
 * - `react-markdown` + `remark-gfm` required for {@link MarkdownCard}
 * - `@terrastruct/d2` optional, only when you supply `onRenderD2`
 * - `docx` optional, only when users click .docx export in MarkdownCard
 */

export type { CardRendererProps } from "./CardRenderer.js";
export { CardRenderer } from "./CardRenderer.js";
export type { ChatMessageInput, ChatMessageProps } from "./ChatMessage.js";
export { ChatMessage } from "./ChatMessage.js";
export type { D2CardProps } from "./D2Card.js";
export { D2Card } from "./D2Card.js";
export type { MarkdownCardProps } from "./MarkdownCard.js";
export { MarkdownCard } from "./MarkdownCard.js";
