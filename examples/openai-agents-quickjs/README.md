# openai-agents-quickjs — OpenAI Agents JS + agentkit-js (D5 StackBlitz demo)

```bash
npm install
node index.mjs
```

`sandboxedJsAgentTool({ kernel })` returns a `Tool` you can drop into an
OpenAI Agents JS `Agent({ tools: [...] })`. The kernel runs anywhere JS
runs — including Cloudflare Workers and Vercel Edge, where OpenAI's own
`SandboxAgent` (Unix-local / Docker / hosted) cannot.

See [`@agentkit-js/openai-agents` README](../../packages/openai-agents/README.md).
