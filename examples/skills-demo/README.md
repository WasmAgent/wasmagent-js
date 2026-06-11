# Skills + lifecycle hooks demo

End-to-end demo of A3. No model calls — runs offline with three registered
skills and a synthetic tool output.

## Run

```bash
bun install            # from the repo root, if not already
node examples/skills-demo/index.mjs
```

## What it shows

1. **Lazy skill loading** — three skills are registered; only the one whose
   trigger matches the task is loaded and inlined into the prompt. The
   demo prints the token cost of "every skill inlined eagerly" vs "only
   matching skills lazy-loaded" and the resulting compression ratio.

2. **Post-tool hook chain** — a `read_file` style output is run through
   `redactPostHook` (replaces API keys) then `truncatePostHook` (keeps a
   bounded tail). The agent only sees the sanitised result.

Expected output:

```
=== Token cost comparison ===
Eager (every skill always inlined):    ~120 tokens
Lazy (matched skills only):            ~50 tokens
Compression ratio:                     ~42%
Activated for "Build a small React component using hooks":
  react-build

=== Post-tool hook chain ===
Raw output (first 80 chars):   "\nconfig.json:\n  api_key=sk-abcdef1234567890\n  endpoint=https://api…"
Sanitised (last 200 chars):    "…[REDACTED]\n  endpoint=https://api.example.com\n  aaaaa…"
Note: API key was redacted, then output trimmed to a 200-char tail.
```

The exact token numbers depend on the instruction text inside each skill;
the ratio matters more than the absolute count.

## See also

- [docs/guides/skills-and-hooks.md](../../docs/guides/skills-and-hooks.md)
