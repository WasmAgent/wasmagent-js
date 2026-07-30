---
"@wasmagent/react": minor
---

feat(react): add `eventMap` option to `useAgentRun` to remap custom event names to built-in handlers

Backends that are structurally compatible with the Cloudflare Worker vocabulary
but use different event *names* (e.g. `text` instead of `text_delta`, `tool_start`
instead of `tool_call`) can now opt in to the hook's built-in message accumulation
without re-implementing it in `onEvent`.

```ts
useAgentRun("/api/stream", {
  eventField: "type",
  channelField: null,
  eventMap: {
    "text":       "text_delta",   // hook accumulates streaming text natively
    "tool_start": "tool_call",    // hook renders tool chip natively
    "tool_end":   "tool_result",  // hook marks tool done natively
  },
  onEvent: (ev) => {
    // Only app-specific events remain here
    if (ev.type === "ui_action") dispatch(ev.action)
  },
})
```

The hook normalizes payloads for remapped events by reading both the standard
nested `data.*` path and the flattened top-level fields (e.g. `ev.delta`,
`ev.name`, `ev.call_id`) so backends that do not wrap their payload under `data`
are handled automatically.

Fixes #295
