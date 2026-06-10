/**
 * TraceRedactor — sanitizes PII / secrets from span attributes before
 * they leave the worker.
 *
 * Default redaction patterns cover common shapes (emails, phone
 * numbers, credit cards, AWS keys, PEM private keys). Consumers can
 * add their own via the `extraPatterns` option.
 */

const DEFAULT_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  { name: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: "<email>" },
  {
    name: "phone",
    re: /\b(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}\b/g,
    replacement: "<phone>",
  },
  { name: "credit-card", re: /\b(?:\d[ -]*?){13,16}\b/g, replacement: "<credit-card>" },
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/g, replacement: "<aws-key>" },
  {
    name: "pem-key",
    re: /-----BEGIN [^-]+ KEY-----[\s\S]*?-----END [^-]+ KEY-----/g,
    replacement: "<pem-key>",
  },
  { name: "openai-key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replacement: "<openai-key>" },
];

export interface TraceRedactorOpts {
  /** Add custom regex patterns. */
  extraPatterns?: Array<{ name: string; re: RegExp; replacement: string }>;
  /** Disable a built-in pattern by name. */
  disablePatterns?: string[];
  /** Enabled by default. Set to false to no-op (e.g. dev-only redaction). */
  enabled?: boolean;
}

export class TraceRedactor {
  readonly #patterns: Array<{ name: string; re: RegExp; replacement: string }>;
  readonly #enabled: boolean;

  constructor(opts: TraceRedactorOpts = {}) {
    const disabled = new Set(opts.disablePatterns ?? []);
    this.#patterns = [
      ...DEFAULT_PATTERNS.filter((p) => !disabled.has(p.name)),
      ...(opts.extraPatterns ?? []),
    ];
    this.#enabled = opts.enabled ?? true;
  }

  /** Redact a single string value. */
  redactString(value: string): string {
    if (!this.#enabled) return value;
    let out = value;
    for (const p of this.#patterns) out = out.replace(p.re, p.replacement);
    return out;
  }

  /**
   * Recursively redact a value. Strings are pattern-replaced; objects
   * and arrays are walked. Numbers, booleans, null pass through.
   */
  redactValue(value: unknown): unknown {
    if (!this.#enabled) return value;
    if (typeof value === "string") return this.redactString(value);
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.redactValue(v);
      }
      return out;
    }
    return value;
  }

  /** Redact a span attributes record in-place style — returns a new object. */
  redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
    return this.redactValue(attrs) as Record<string, unknown>;
  }
}
