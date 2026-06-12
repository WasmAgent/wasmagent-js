# @agentkit-js/model-local

> Embedded local-LLM provider for [agentkit-js](https://github.com/telleroutlook/agentkit-js) — `node-llama-cpp` adapter with grammar-constrained tool calling, multi-mirror downloads (HuggingFace / hf-mirror / ModelScope), and a certification harness for picking which models actually work in agent workflows.

The whole agent stack — model, code execution, state — runs on the user's machine. No cloud LLM, no API key, no telemetry.

## Install

```bash
# Provider (small package, no native deps).
npm install @agentkit-js/model-local

# Optional native peer — pre-built binaries for macOS/Linux/Windows + ARM/x64.
npm install node-llama-cpp
```

The native peer is **optional**: if you only want the registry/downloader/types (e.g. to ship a server that proxies models), you can skip it. `LocalModel.generate()` will throw a typed `LocalModelDependencyError` with an actionable install hint if it's missing.

## Quick start

```ts
import { LocalModel, localFirst } from "@agentkit-js/model-local";
import { AnthropicModel, CodeAgent } from "@agentkit-js/core";

// Pick one of three sources:
const local = new LocalModel({ source: { model: "qwen3.5-0.8b" } });        // alias
// or:        new LocalModel({ source: { path: "./my-model.gguf" } });       // user GGUF
// or:        new LocalModel({ source: { url: "https://..." } });            // direct URL

// Use it directly:
const agent = new CodeAgent({ model: local, tools: [] });

// Or compose with a cloud fallback for prod:
const model = localFirst(
  local,
  new AnthropicModel("claude-haiku-4-5-20251001", process.env.ANTHROPIC_API_KEY),
);
```

## Three model sources

| Source | Use when | Verification |
|---|---|---|
| `{ model: "alias" }` | You want a maintained, vetted model | sha256 (registry-pinned) |
| `{ path: "./x.gguf" }` | You have a self-trained or hand-downloaded GGUF | none (your file, your trust) |
| `{ url: "https://..." }` | One-off pull from any URL | sha256 only if you supply `expectedSha256` |

## Mirror selection (大陆友好)

Three resolution layers, high → low precedence:

1. **Programmatic** — `new LocalModel({ source: { model: "qwen3.5-0.8b" }, mirror: "modelscope" })`
2. **Environment** — `AGENTKIT_MODEL_MIRROR=hf-mirror` (or `modelscope`, or any URL prefix)
3. **Registry default** — HuggingFace first, then mirrors

Built-in presets:
- `huggingface` — origin (sha256 anchor)
- `hf-mirror` — `hf-mirror.com`, community-run, URL-compatible with HF
- `modelscope` — `modelscope.cn`, ModelScope魔搭 国内 CDN

Custom CDN: pass any URL prefix as `mirror`, and the downloader will append the canonical filename and hit your CDN first, falling back to the registry chain if it fails.

```bash
# One-line CLI override:
AGENTKIT_MODEL_MIRROR=modelscope npx agentkit model pull qwen3.5-0.8b
```

⚠️ **Mirror trust model**: every download is sha256-verified against the registry value (which is anchored to the HuggingFace original). Mirrors are *transport channels*, not trust roots.

## Grammar-constrained tool calling

Sub-1B models routinely emit malformed JSON when asked to call tools. `LocalModel` enables JSON-schema grammar in the sampler by default, so `tool_use` output is **structurally legal 100% of the time**. Semantic correctness still depends on the model.

```ts
const model = new LocalModel({
  source: { model: "qwen3.5-0.8b" },
  enableGrammar: true,  // default
});
```

Set `enableGrammar: false` to compare A/B against free-form sampling — useful for diffing on the cert harness.

## CLI

```bash
# Browse the registry.
agentkit model list

# Pull (resumable, sha256-verified, multi-mirror).
agentkit model pull qwen3.5-0.8b

# Force a mirror.
agentkit model pull qwen3.5-0.8b --mirror modelscope

# Verify a cached file's sha256.
agentkit model verify qwen3.5-0.8b

# Free up disk.
agentkit model rm qwen3.5-0.8b
```

`agentkit-js/cli` declares `@agentkit-js/model-local` as an **optional peer** — if you don't install this package, the CLI falls back to a clean error message rather than crashing.

## Routing presets

```ts
import { localFirst, offlineOnly, devLocalOr } from "@agentkit-js/model-local";

// Try local; fall through to cloud on any error.
const a = localFirst(localModel, cloudModel);

// Loud "no cloud, ever" envelope (passthrough today; reserves a hook for
// future enforcement).
const b = offlineOnly(localModel);

// Dev convenience: AGENTKIT_DEV_LOCAL=1 → local; otherwise → cloud.
const c = devLocalOr(localModel, cloudModel);
```

These are documented combinations of the existing `FallbackModel` from `@agentkit-js/core` — *not* a parallel routing mechanism. You get the same retry/fallover semantics as everywhere else in the framework.

## Recommended models — current registry

> All entries are <1.5 GB at q4_k_m quantisation. The `recommended` flag flips on once the cert harness publishes a passing score (see L4). Until then you can still `agentkit model pull <alias>` and self-evaluate.

| Alias | Best for | License | Size (Q4) |
|---|---|---|---|
| `qwen3.5-0.8b` | Chinese + English, 262K context | Apache-2.0 | ~530 MB |
| `qwen3-0.6b` | English/code, smaller footprint | Apache-2.0 | ~400 MB |
| `gemma-3-1b` | English tasks, broad community | Gemma ToU | ~720 MB |
| `llama-3.2-1b` | English/code, 128K context | Llama 3.2 Community | ~800 MB |

Run the cert harness on any of them (or your own GGUF):

```bash
node examples/benchmarks/local-model-cert.mjs --model qwen3.5-0.8b --kernel quickjs
node examples/benchmarks/local-model-cert.mjs --path ./my-model.gguf --out report.md
```

## Honest caveats

- **Sub-1B models are not Claude/GPT-class.** Complex tool routing, multi-step reasoning, and long-form synthesis are still cloud-class jobs. The local model is for high-frequency, lower-difficulty work — drafts, intent classification, summarisation, dev/CI runs.
- **Grammar guarantees form, not semantics.** A grammar-clean output can still pick the wrong tool or wrong arguments. The cert harness's *form rate* and *semantic rate* are reported separately.
- **Native binding.** `node-llama-cpp` brings prebuilt binaries but requires Node.js 20+ on a desktop/server platform. **Cloudflare Workers cannot run this.** Use `localFirst` with a cloud model if you deploy to edge runtimes.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

Model files have their own licenses; they are downloaded from the publisher's host on demand and never re-distributed by this package. See `MODEL_REGISTRY` (in `src/registry.ts`) for the license attribute on each entry.
