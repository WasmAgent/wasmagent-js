import {
  AEP_SPAN_NAMES,
  agentRunSpanAttrs,
  AlwaysOffSampler,
  AlwaysOnSampler,
  type Baggage,
  extractBaggage,
  FineGrainedMetrics,
  injectBaggage,
  llmGenerateSpanAttrs,
  mcpRequestSpanAttrs,
  policyCheckSpanAttrs,
  ProbabilisticSampler,
  parseBaggageHeader,
  RateLimitingSampler,
  sandboxExecSpanAttrs,
  serializeBaggage,
  toolCallSpanAttrs,
  TraceRedactor,
  verifierCheckSpanAttrs,
} from "./index.js";

describe("Sampler implementations", () => {
  it("AlwaysOnSampler always returns true", () => {
    const s = new AlwaysOnSampler();
    expect(s.shouldSample("any")).toBe(true);
    expect(s.shouldSample("other")).toBe(true);
  });

  it("AlwaysOffSampler always returns false", () => {
    const s = new AlwaysOffSampler();
    expect(s.shouldSample("any")).toBe(false);
  });

  it("ProbabilisticSampler is deterministic per traceId", () => {
    const s = new ProbabilisticSampler(0.5);
    expect(s.shouldSample("trace-1")).toBe(s.shouldSample("trace-1"));
    expect(s.shouldSample("trace-2")).toBe(s.shouldSample("trace-2"));
  });

  it("ProbabilisticSampler at rate=1 always samples", () => {
    const s = new ProbabilisticSampler(1);
    for (let i = 0; i < 100; i++) expect(s.shouldSample(`t${i}`)).toBe(true);
  });

  it("ProbabilisticSampler at rate=0 never samples", () => {
    const s = new ProbabilisticSampler(0);
    for (let i = 0; i < 100; i++) expect(s.shouldSample(`t${i}`)).toBe(false);
  });

  it("ProbabilisticSampler rejects out-of-range rates", () => {
    expect(() => new ProbabilisticSampler(-0.1)).toThrow();
    expect(() => new ProbabilisticSampler(1.1)).toThrow();
  });

  it("RateLimitingSampler caps per second", () => {
    const s = new RateLimitingSampler(3);
    expect(s.shouldSample("t")).toBe(true);
    expect(s.shouldSample("t")).toBe(true);
    expect(s.shouldSample("t")).toBe(true);
    expect(s.shouldSample("t")).toBe(false);
  });
});

describe("TraceRedactor", () => {
  it("redacts emails", () => {
    const r = new TraceRedactor();
    expect(r.redactString("Contact me at alice@example.com")).toBe("Contact me at <email>");
  });

  it("redacts AWS keys", () => {
    const r = new TraceRedactor();
    expect(r.redactString("key=AKIAIOSFODNN7EXAMPLE")).toBe("key=<aws-key>");
  });

  it("redacts OpenAI-style sk- keys", () => {
    const r = new TraceRedactor();
    const out = r.redactString("auth: sk-proj-aaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toContain("<openai-key>");
  });

  it("walks objects recursively", () => {
    const r = new TraceRedactor();
    const out = r.redactValue({ user: "x@y.com", nested: { phone: "415 555 0123" } });
    expect(out).toEqual({ user: "<email>", nested: { phone: "<phone>" } });
  });

  it("can be disabled", () => {
    const r = new TraceRedactor({ enabled: false });
    expect(r.redactString("x@y.com")).toBe("x@y.com");
  });

  it("disablePatterns turns off specific built-ins", () => {
    const r = new TraceRedactor({ disablePatterns: ["email"] });
    expect(r.redactString("x@y.com")).toBe("x@y.com");
  });

  it("extraPatterns adds custom redactions", () => {
    const r = new TraceRedactor({
      extraPatterns: [{ name: "session", re: /sess_[a-f0-9]+/g, replacement: "<session>" }],
    });
    expect(r.redactString("sess_abc123def")).toBe("<session>");
  });
});

describe("BaggagePropagator", () => {
  it("parses simple baggage header", () => {
    expect(parseBaggageHeader("user-id=alice,session-id=42")).toEqual({
      "user-id": "alice",
      "session-id": "42",
    });
  });

  it("decodes URI-encoded keys + values", () => {
    expect(parseBaggageHeader("k%20with%20space=v%2Fwith%2Fslash")).toEqual({
      "k with space": "v/with/slash",
    });
  });

  it("strips metadata after semicolon", () => {
    expect(parseBaggageHeader("user=alice;ttl=60,role=admin")).toEqual({
      user: "alice",
      role: "admin",
    });
  });

  it("returns empty object for null/empty", () => {
    expect(parseBaggageHeader(null)).toEqual({});
    expect(parseBaggageHeader("")).toEqual({});
  });

  it("serializes baggage to header form", () => {
    const baggage: Baggage = { "user-id": "alice", "session-id": "42" };
    expect(serializeBaggage(baggage)).toBe("user-id=alice,session-id=42");
  });

  it("URI-encodes special chars on serialize", () => {
    expect(serializeBaggage({ key: "v with space" })).toBe("key=v%20with%20space");
  });

  it("extractBaggage reads from a Request-like object", () => {
    const req = { headers: { get: () => "tenant=acme" } };
    expect(extractBaggage(req)).toEqual({ tenant: "acme" });
  });

  it("injectBaggage sets the baggage header", () => {
    const headers = new Headers();
    injectBaggage(headers, { user: "alice" });
    expect(headers.get("baggage")).toBe("user=alice");
  });
});

describe("FineGrainedMetrics", () => {
  it("aggregates token + cost across recorded steps", () => {
    const m = new FineGrainedMetrics();
    m.recordStep({
      stepIndex: 0,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });
    m.recordStep({
      stepIndex: 1,
      durationMs: 150,
      inputTokens: 20,
      outputTokens: 8,
      costUsd: 0.002,
    });
    const snap = m.snapshot();
    expect(snap.totalInputTokens).toBe(30);
    expect(snap.totalOutputTokens).toBe(13);
    expect(snap.totalCostUsd).toBeCloseTo(0.003, 6);
    expect(snap.steps).toHaveLength(2);
  });

  it("tallies tool errors per name", () => {
    const m = new FineGrainedMetrics();
    m.recordToolError("search");
    m.recordToolError("search");
    m.recordToolError("calc");
    const snap = m.snapshot();
    expect(snap.toolErrors).toEqual(
      expect.arrayContaining([
        { toolName: "search", count: 2 },
        { toolName: "calc", count: 1 },
      ])
    );
  });

  it("reset clears state", () => {
    const m = new FineGrainedMetrics();
    m.recordStep({ stepIndex: 0, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    m.reset();
    expect(m.snapshot().steps).toEqual([]);
  });
});

describe("AEP span names", () => {
  it("AEP_SPAN_NAMES constants match expected string values", () => {
    expect(AEP_SPAN_NAMES.MCP_REQUEST).toBe("mcp.request");
    expect(AEP_SPAN_NAMES.POLICY_CHECK).toBe("policy.check");
    expect(AEP_SPAN_NAMES.SANDBOX_EXEC).toBe("sandbox.exec");
    expect(AEP_SPAN_NAMES.VERIFIER_CHECK).toBe("verifier.check");
    expect(AEP_SPAN_NAMES.REDACTION_APPLY).toBe("redaction.apply");
    expect(AEP_SPAN_NAMES.DATASET_EXPORT).toBe("dataset.export");
  });

  it("mcpRequestSpanAttrs maps server_id and tool_name to correct keys", () => {
    const attrs = mcpRequestSpanAttrs({ server_id: "s1", tool_name: "bash" });
    expect(attrs["mcp.server_id"]).toBe("s1");
    expect(attrs["mcp.tool_name"]).toBe("bash");
    expect("mcp.request_id" in attrs).toBe(false);
  });

  it("mcpRequestSpanAttrs includes optional request_id when provided", () => {
    const attrs = mcpRequestSpanAttrs({ server_id: "s2", tool_name: "read_file", request_id: "req-42" });
    expect(attrs["mcp.request_id"]).toBe("req-42");
  });

  it("policyCheckSpanAttrs maps all four fields", () => {
    const attrs = policyCheckSpanAttrs({ policy_id: "p1", subject: "agent:x", resource: "file:/tmp/foo", decision: "allow" });
    expect(attrs["policy.policy_id"]).toBe("p1");
    expect(attrs["policy.subject"]).toBe("agent:x");
    expect(attrs["policy.resource"]).toBe("file:/tmp/foo");
    expect(attrs["policy.decision"]).toBe("allow");
  });

  it("sandboxExecSpanAttrs includes kernel_type and optional fields", () => {
    const minimal = sandboxExecSpanAttrs({ kernel_type: "quickjs" });
    expect(minimal["sandbox.kernel_type"]).toBe("quickjs");
    expect("sandbox.session_id" in minimal).toBe(false);
    expect("sandbox.exit_code" in minimal).toBe(false);

    const full = sandboxExecSpanAttrs({ kernel_type: "remote", session_id: "sess-1", exit_code: 0 });
    expect(full["sandbox.session_id"]).toBe("sess-1");
    expect(full["sandbox.exit_code"]).toBe("0");
  });

  it("verifierCheckSpanAttrs maps passed as a string and omits score when absent", () => {
    const attrs = verifierCheckSpanAttrs({ verifier_id: "DeterministicVerifier", passed: true });
    expect(attrs["verifier.verifier_id"]).toBe("DeterministicVerifier");
    expect(attrs["verifier.passed"]).toBe("true");
    expect("verifier.score" in attrs).toBe(false);
  });

  it("verifierCheckSpanAttrs includes score when provided", () => {
    const attrs = verifierCheckSpanAttrs({ verifier_id: "ScalarLLMJudgeVerifier", passed: false, score: 0.42 });
    expect(attrs["verifier.score"]).toBe("0.42");
    expect(attrs["verifier.passed"]).toBe("false");
  });
});

describe("AEP span names — agent/llm/tool", () => {
  it("AEP_SPAN_NAMES.AGENT_RUN === 'agent.run'", () => {
    expect(AEP_SPAN_NAMES.AGENT_RUN).toBe("agent.run");
  });

  it("AEP_SPAN_NAMES.LLM_GENERATE === 'llm.generate'", () => {
    expect(AEP_SPAN_NAMES.LLM_GENERATE).toBe("llm.generate");
  });

  it("AEP_SPAN_NAMES.TOOL_CALL === 'tool.call'", () => {
    expect(AEP_SPAN_NAMES.TOOL_CALL).toBe("tool.call");
  });

  it("agentRunSpanAttrs maps agent_name to correct key", () => {
    const attrs = agentRunSpanAttrs({ agent_name: "MyAgent" });
    expect(attrs["agent.name"]).toBe("MyAgent");
    expect("agent.run_id" in attrs).toBe(false);
    expect("agent.model_id" in attrs).toBe(false);
  });

  it("agentRunSpanAttrs includes optional run_id and model_id when provided", () => {
    const attrs = agentRunSpanAttrs({ agent_name: "MyAgent", run_id: "run-1", model_id: "claude-3" });
    expect(attrs["agent.run_id"]).toBe("run-1");
    expect(attrs["agent.model_id"]).toBe("claude-3");
  });

  it("llmGenerateSpanAttrs maps model_id to correct key", () => {
    const attrs = llmGenerateSpanAttrs({ model_id: "gpt-4o" });
    expect(attrs["llm.model_id"]).toBe("gpt-4o");
    expect("llm.provider" in attrs).toBe(false);
  });

  it("llmGenerateSpanAttrs includes optional token counts as strings", () => {
    const attrs = llmGenerateSpanAttrs({ model_id: "gpt-4o", provider: "openai", input_tokens: 100, output_tokens: 50 });
    expect(attrs["llm.provider"]).toBe("openai");
    expect(attrs["llm.input_tokens"]).toBe("100");
    expect(attrs["llm.output_tokens"]).toBe("50");
  });

  it("toolCallSpanAttrs maps tool_name and state_changing to correct keys", () => {
    const attrs = toolCallSpanAttrs({ tool_name: "bash", state_changing: true });
    expect(attrs["tool.name"]).toBe("bash");
    expect(attrs["tool.state_changing"]).toBe("true");
    expect("tool.type" in attrs).toBe(false);
  });

  it("toolCallSpanAttrs includes optional tool_type when provided", () => {
    const attrs = toolCallSpanAttrs({ tool_name: "read_file", tool_type: "mcp", state_changing: false });
    expect(attrs["tool.type"]).toBe("mcp");
    expect(attrs["tool.state_changing"]).toBe("false");
  });
});
