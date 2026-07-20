---
"@wasmagent/mcp-firewall": minor
---

feat(mcp-firewall): pluggable semantic defense layer for paraphrase-based injection detection

Adds a third detection phase (semantic similarity) to the vetting pipeline:
- `SemanticDetector` interface for pluggable embedding models
- `TfidfSemanticDetector` zero-dependency fallback using TF-IDF + cosine similarity
- `vetToolAsync()` async vetting function that runs all three phases
- `semantic_paraphrase` finding type for paraphrase-detected injections
- Default malicious corpus covering 5 MCPTox-aligned categories

Reference: CASCADE (arXiv:2604.17125), ZEDD (arXiv:2601.12359)
