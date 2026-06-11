# chat-cards — `@agentkit-js/ui-cards-react` browser demo

A small Vite + React app that renders the agent's `card:*` output blocks
(Markdown, D2 diagrams, code blocks, JSON tables) using the
`@agentkit-js/ui-cards-react` component library.

## Run

```bash
pnpm install
pnpm --filter chat-cards dev
# → http://localhost:5173
```

The app does not call a real model — it ships with a curated set of canned
agent events so the renderer can be styled and reviewed without an API key.
Edit `src/fixtures.ts` to swap in your own.

## What it shows

- `<ChatMessage />` rendering of mixed text + cards.
- `<CardRenderer />` with the standard card kinds: markdown, code, d2,
  table, html. Each card honours its `meta` field (e.g. language, height).
- The recommended layout — left rail of messages, right pane for the
  selected card at full size — that bscode and other production UIs use.

## Build

```bash
pnpm --filter chat-cards build
# emits dist/ — static deploy target (Cloudflare Pages, Vercel, GitHub Pages)
```

For a fully wired agent + live SSE loop, see [`cf-production/`](../cf-production/).
