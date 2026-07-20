# Semantic Defense Layer (Phase 3)

## Overview

The semantic defense layer adds embedding-based detection to catch paraphrase-based
prompt injections that bypass keyword and n-gram matching.

## Architecture

Three-phase detection pipeline:
1. **Keyword scan** -- fast regex/string match (existing)
2. **N-gram logistic regression** -- statistical pattern matching (existing)
3. **Semantic similarity** -- embedding cosine match against malicious corpus (new, optional)

## Configuration

### Default (zero-dependency TF-IDF fallback)

```ts
import { vetToolAsync, TfidfSemanticDetector } from '@wasmagent/mcp-firewall'

const detector = new TfidfSemanticDetector({
  warnThreshold: 0.82,
  blockThreshold: 0.90,
})

const result = await vetToolAsync(toolDef, { semanticDetector: detector })
```

### Production (embedding model via fastembed)

```ts
import { EmbeddingModel } from 'fastembed'
// Implement SemanticDetector interface with real embeddings
// See examples/semantic-defense/ for reference implementation
```

## Supported Models

| Model | Dimensions | Size | npm Package |
|-------|-----------|------|-------------|
| BAAI/bge-small-en-v1.5 (recommended) | 384 | ~33M | fastembed |
| sentence-transformers/all-MiniLM-L6-v2 | 384 | ~22M | fastembed |
| Custom | any | any | Implement SemanticDetector interface |

## Thresholds

| Threshold | Default | Meaning |
|-----------|---------|---------|
| warnThreshold | 0.82 | Findings with severity 'medium' |
| blockThreshold | 0.90 | Findings with severity 'critical' |

Thresholds are empirically tuned. Calibrate against your specific threat model.
References: CASCADE (arXiv:2604.17125), ZEDD (arXiv:2601.12359).

## Custom Corpus

```ts
const detector = new TfidfSemanticDetector({
  corpus: [
    { text: "your custom malicious pattern", category: "custom_category" },
    // ...
  ],
})
```

## API Reference

### SemanticDetector interface

```ts
interface SemanticDetector {
  detect(text: string): Promise<SemanticDetectionResult>;
}

interface SemanticDetectionResult {
  score: number;             // 0.0 - 1.0
  matchedCategory?: string;  // only set when score >= warnThreshold
  matchedEntry?: string;     // the corpus entry text (debugging)
}
```

### vetToolAsync

```ts
async function vetToolAsync(
  entry: McpToolEntry,
  options?: VetToolOptions
): Promise<VettingResult>
```

Async version of `vetTool()` that supports the optional semantic detection phase.
When `options.semanticDetector` is not provided, behaves identically to `vetTool()`.

### FindingType

The `semantic_paraphrase` finding type is emitted when the semantic detector
matches a tool field against the malicious corpus above the warn threshold.
