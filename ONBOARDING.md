# Onboarding — WasmAgent ecosystem (60-minute path to your first PR)

> **Scope.** This is the shared onboarding guide for **all three
> WasmAgent open-source repos**: [`wasmagent-js`](https://github.com/WasmAgent/wasmagent-js),
> [`bscode`](https://github.com/WasmAgent/bscode), and
> [`trace-pipeline`](https://github.com/WasmAgent/trace-pipeline).
> Sibling repos' `ONBOARDING.md` just links here — when the procedure
> changes, edit this file only.

This guide gets a new contributor from `git clone` to a green
pre-push hook in under an hour. If anything here takes longer than
expected, the doc is wrong — open an issue.

---

## 0. Prerequisites (10 min)

You need three system installs. Recommended approach: use
[**mise**](https://mise.jdx.dev/) or [**asdf**](https://asdf-vm.com/)
so the exact pinned versions land automatically.

```bash
# macOS via Homebrew
brew install mise gh git

# Linux
curl https://mise.run | sh   # then add to your shell rc
sudo apt install gh git      # or your distro's equivalent
```

Authenticate to GitHub once:

```bash
gh auth login
```

---

## 1. Clone all three repos (5 min)

The three repos sit side-by-side as **separate clones**, not as a
monorepo or as submodules. Some scripts cross-reference via relative
paths (e.g. shared `rollout-branches.v1.jsonl` fixture) — easiest if
they share a parent directory:

```bash
mkdir -p ~/wasmagent && cd ~/wasmagent
gh repo clone WasmAgent/wasmagent-js
gh repo clone WasmAgent/bscode
gh repo clone WasmAgent/trace-pipeline
```

In each clone, the `.tool-versions` file pins the exact runtime:

```bash
cd wasmagent-js   && mise install     # installs node 20.18.1, bun 1.3.14
cd ../bscode      && mise install     # same node + bun
cd ../trace-pipeline && mise install  # installs python 3.11.10
```

(If you're not using mise/asdf: read `.tool-versions` and install
those exact versions manually. **`bun` 1.3.14 specifically** —
1.3.15+ has an isolation bug, 1.4.x has not been tested.)

---

## 2. Get credentials (5 min — ask the maintainer)

**Do not commit any of these.** They go in `.env.local` (gitignored).

| What | From whom | Where to put |
|---|---|---|
| `BSCODE_CLIENT_TOKEN` | Generate your own: `openssl rand -hex 32` | `bscode/.env.local` |
| LLM API keys (Anthropic, OpenAI, DeepSeek, Doubao, ...) | Your own provider accounts | `wasmagent-js/.env.local`, `bscode/.env.local` |
| `BSCODE_AEP_SEED` | Ask in 1Password vault `wasmagent-dev` | `bscode/.env.local` |
| `WASMAGENT_AEP_PUBKEY_*` (verifier keys) | Ask in 1Password vault `wasmagent-dev` | `trace-pipeline/.env.local` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Create your own at dash.cloudflare.com, or `wrangler login` | `bscode/.env.local` (only if you deploy) |
| `NPM_TOKEN` | **Not needed for local dev.** Maintainers only. | — |

`.env.example` in each repo lists exactly what variables that repo
reads. Copy → fill → done:

```bash
cd wasmagent-js && cp .env.example .env.local
cd ../bscode    && cp .env.example .env.local
cd ../trace-pipeline && cp .env.example .env.local
```

> **Re NPM_TOKEN.** Publishing to npm goes through GitHub Actions
> with a maintainer-owned token. If you need to publish, see
> `wasmagent-js/CLAUDE.md` → "Release & publish" → "Preventing E404
> forever". Each maintainer needs Granular Token with **both**
> `@wasmagent/*` packages scope **and** `wasmagent` org write
> permission — missing the second panel returns a misleading E404.

---

## 3. Install pre-push hook in every clone (2 min × 3)

Every repo has a `.githooks/pre-push` that mirrors CI exactly
(lint + no-control-bytes + typecheck + build + tests + publish
readiness). Without it you will repeatedly push red commits and
discover via CI emails 3 minutes later. Install once per clone:

```bash
cd wasmagent-js  && bash .githooks/install.sh
cd ../bscode     && bash .githooks/install.sh
cd ../trace-pipeline && bash .githooks/install.sh
```

The hook takes ~50s per push on first run, much less on subsequent
runs (turbo cache). Emergency bypass: `git push --no-verify`. Do
**not** habitually use the bypass — branch protection on `main`
(see [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md)) will reject your
push anyway.

---

## 4. First green run in each repo (15 min)

### wasmagent-js (JavaScript / TypeScript)

```bash
cd ~/wasmagent/wasmagent-js
bun install                       # installs all workspace deps
bun test packages/aep/src/        # 15 tests, ~80ms
bun test packages/mcp-firewall/src/   # 69 tests, ~90ms
```

If you see `429 Too Many Requests` from the npm mirror, switch to
the official registry: `bun install --registry=https://registry.npmjs.org`.

### bscode (Cloudflare Workers + Next.js)

```bash
cd ~/wasmagent/bscode
bun install
bun run test                      # bun --filter @bscode/worker test
                                  # 498 tests, ~2s
bun run dev:worker                # local Wrangler dev server, port 8788
```

> Note: `bun run test` (not bare `bun test` from root). bscode's
> `bunfig.toml` is per-package and `bun --filter` is the only path
> that honours `--isolate`. See bscode's `CLAUDE.md` for the why.

### trace-pipeline (Python)

```bash
cd ~/wasmagent/trace-pipeline
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
pytest tests/ -x -q              # 514 tests, ~2s
```

---

## 5. Make your first PR (20 min)

The three repos all enforce **PR-only** updates to `main` (branch
protection — see [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md)).
The workflow is identical in all three:

```bash
git checkout -b feat/<short-description>     # or fix/, docs/, ci/
# ... make your change, run tests locally ...
git push -u origin feat/<short-description>  # pre-push hook runs
gh pr create --fill                          # CI starts on the PR
gh pr merge --squash --auto                  # auto-merges when CI is green
```

### Commit message style

Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`, ...).
The PR title becomes the squash-merge commit subject — keep it
≤ 72 chars and imperative ("add", not "added"). For changes that
ship to npm, also add a changeset (`bunx changeset`) **before**
pushing — without it the Release workflow stays silent.

### Branch naming

| Prefix | Meaning |
|---|---|
| `feat/` | New feature or capability |
| `fix/` | Bug fix |
| `docs/` | Docs / comments only |
| `ci/` | CI / build / scripts |
| `chore/` | Refactors, cleanups, dep bumps |
| `release/` | Manual release branches (rare) |
| `scratch/`, `wip/`, `draft/` | Pre-push hook skips on these |

---

## 6. Tooling cheatsheet

| Command | What it does | Where |
|---|---|---|
| `bun test <path>` | Run tests in one package | `wasmagent-js` |
| `bun run test` | Run all tests via turbo | `wasmagent-js`, `bscode` |
| `bun run lint` | Biome check | `wasmagent-js`, `bscode` |
| `bun run typecheck` | tsc --noEmit across packages | `wasmagent-js`, `bscode` |
| `npm run build` | Full turbo build (matches CI) | `wasmagent-js` |
| `npm run check:all` | One-shot CI equivalent | `wasmagent-js` |
| `pytest tests/ -x -q` | Run Python tests | `trace-pipeline` |
| `ruff check eval_trust/ evomerge/ scripts/ tests/` | Python lint | `trace-pipeline` |
| `make test` | Test + reproducer + smoke examples | `trace-pipeline` |
| `bunx changeset` | Describe a release-worthy change | `wasmagent-js` |
| `bunx changeset status` | Preview pending version bumps | `wasmagent-js` |

---

## 7. Where to ask for help

| Symptom | First check |
|---|---|
| Local tests pass, CI red | `<repo>/CLAUDE.md` → "Local–CI parity" foot-gun table |
| `npm publish` returns E404 | `wasmagent-js/CLAUDE.md` → "Release & publish" → "Preventing E404 forever" |
| Pre-push hook reports a check you don't recognise | `<repo>/.githooks/pre-push` is short and readable; the message includes the exact command to run manually |
| Release PR is `UNSTABLE` mergeable state | `wasmagent-js/CLAUDE.md` → "Transient failures and recovery" — usually safe to merge |
| `@noble/ed25519: s.digest is not a function` mid-test | Cross-package test pollution; run each package separately: `bun test packages/aep/src/` |
| Stuck after 15 minutes on something not above | Open an issue with `[onboarding]` in the title |

---

## 8. What this ecosystem actually is

Read in this order:

1. **`wasmagent-js/README.md`** — the umbrella story (verifiable
   evidence layer + security control plane for MCP agents).
2. **`wasmagent-js/docs/ecosystem.md`** — how the three repos talk
   to each other.
3. **`wasmagent-js/docs/aep-contract.md`** — the cross-repo data
   contract (`AEPRecord` v0.2).
4. **`wasmagent-js/CLAUDE.md`** — runtime conventions, release
   flow, foot-guns.
5. **`bscode/CLAUDE.md`** + **`trace-pipeline/CLAUDE.md`** — repo-
   specific rules (test commands, deploy, etc.).

That's about 8000 words; an afternoon. After that, pick any open
issue tagged `good-first-issue` and submit a PR.
