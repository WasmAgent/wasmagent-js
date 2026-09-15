/**
 * Sink-source structural policy — test suite.
 *
 * Test IDs in comments match the task spec:
 *   FS-GUARD-*   credential path rules
 *   NET-GUARD-*  network sink rules (secret-to-network, SSRF)
 *   CMD-GUARD-*  shell execution rules
 *   SINK-CLASS-* classification helpers
 *   FULL-RULES-* rule collection composition
 *   BENIGN-*     false-positive checks
 */

import { describe, expect, it } from "bun:test";
import {
  classifyArgSource,
  classifyToolSinks,
  CREDENTIAL_PATH_RULE,
  DEFAULT_RULES,
  FULL_DEFAULT_RULES,
  SECRET_NETWORK_SINK_RULE,
  SHELL_EXEC_CAPABILITY_RULE,
  SINK_POLICY_RULES,
  SSRF_LOCALHOST_RULE,
} from "./index.js";

// ── Credential path guard ─────────────────────────────────────────────────────

describe("FS-GUARD-01: ~/.ssh/id_rsa → deny", () => {
  it("denies access to SSH private key path", () => {
    const result = CREDENTIAL_PATH_RULE.evaluate(
      "read_file",
      { path: "~/.ssh/id_rsa" },
      null
    );
    expect(result).toBe("deny");
  });
});

describe("FS-GUARD-02: ~/.aws/credentials → deny", () => {
  it("denies access to AWS credentials file", () => {
    const result = CREDENTIAL_PATH_RULE.evaluate(
      "read_file",
      { path: "~/.aws/credentials" },
      null
    );
    expect(result).toBe("deny");
  });
});

// ── Network sink guards ───────────────────────────────────────────────────────

describe("NET-GUARD-01: secret arg + network tool → deny", () => {
  it("denies sending a token to a network endpoint", () => {
    const result = SECRET_NETWORK_SINK_RULE.evaluate(
      "send_request",
      { token: "sk-abc123" },
      null
    );
    expect(result).toBe("deny");
  });
});

describe("NET-GUARD-02: localhost URL → deny", () => {
  it("denies SSRF to localhost:8080", () => {
    const result = SSRF_LOCALHOST_RULE.evaluate(
      "http_request",
      { url: "http://localhost:8080/admin" },
      null
    );
    expect(result).toBe("deny");
  });
});

describe("NET-GUARD-03: IMDS URL 169.254.169.254 → deny", () => {
  it("denies SSRF to cloud instance metadata service", () => {
    const result = SSRF_LOCALHOST_RULE.evaluate(
      "fetch_url",
      { url: "http://169.254.169.254/metadata" },
      null
    );
    expect(result).toBe("deny");
  });
});

// ── Shell execution guard ─────────────────────────────────────────────────────

describe("CMD-GUARD-01: execute_command → ask_user", () => {
  it("escalates to ask_user for command execution tools", () => {
    const result = SHELL_EXEC_CAPABILITY_RULE.evaluate(
      "execute_command",
      { command: "ls -la" },
      null
    );
    expect(result).toBe("ask_user");
  });
});

describe("CMD-GUARD-02: run_bash_script → ask_user", () => {
  it("escalates to ask_user for bash script runner tools", () => {
    const result = SHELL_EXEC_CAPABILITY_RULE.evaluate(
      "run_bash_script",
      { script: "echo hello" },
      null
    );
    expect(result).toBe("ask_user");
  });
});

// ── Sink classification helpers ───────────────────────────────────────────────

describe("SINK-CLASS-01: write_file → filesystem_write", () => {
  it("classifies write_file as a filesystem_write sink", () => {
    const sinks = classifyToolSinks({ name: "write_file" });
    expect(sinks).toContain("filesystem_write");
  });
});

describe("SINK-CLASS-02: http_request → network_send", () => {
  it("classifies http_request as a network_send sink", () => {
    const sinks = classifyToolSinks({ name: "http_request" });
    expect(sinks).toContain("network_send");
  });
});

describe("SINK-CLASS-03: classifyArgSource for token → secret", () => {
  it("classifies a 'token' argument as a secret source", () => {
    expect(classifyArgSource("token", "abc123")).toBe("secret");
  });
});

describe("SINK-CLASS-04: classifyArgSource for file_path → filesystem", () => {
  it("classifies a 'file_path' argument as a filesystem source", () => {
    expect(classifyArgSource("file_path", "/etc/hosts")).toBe("filesystem");
  });
});

// ── Rule collection composition ───────────────────────────────────────────────

describe("FULL-RULES-01: FULL_DEFAULT_RULES contains all DEFAULT_RULES and SINK_POLICY_RULES", () => {
  it("includes every rule from DEFAULT_RULES", () => {
    const fullIds = FULL_DEFAULT_RULES.map((r) => r.policyId);
    for (const r of DEFAULT_RULES) {
      expect(fullIds).toContain(r.policyId);
    }
  });

  it("includes every rule from SINK_POLICY_RULES", () => {
    const fullIds = FULL_DEFAULT_RULES.map((r) => r.policyId);
    for (const r of SINK_POLICY_RULES) {
      expect(fullIds).toContain(r.policyId);
    }
  });

  it("has length equal to DEFAULT_RULES + SINK_POLICY_RULES", () => {
    expect(FULL_DEFAULT_RULES.length).toBe(DEFAULT_RULES.length + SINK_POLICY_RULES.length);
  });
});

// ── Benign tool — no false positives ─────────────────────────────────────────

describe("BENIGN-01: read_weather with city arg → all rules return undefined", () => {
  const toolName = "read_weather";
  const args = { city: "London" };

  it("SHELL_EXEC_CAPABILITY_RULE does not fire", () => {
    expect(SHELL_EXEC_CAPABILITY_RULE.evaluate(toolName, args, null)).toBeUndefined();
  });

  it("SECRET_NETWORK_SINK_RULE does not fire", () => {
    expect(SECRET_NETWORK_SINK_RULE.evaluate(toolName, args, null)).toBeUndefined();
  });

  it("SSRF_LOCALHOST_RULE does not fire", () => {
    expect(SSRF_LOCALHOST_RULE.evaluate(toolName, args, null)).toBeUndefined();
  });

  it("CREDENTIAL_PATH_RULE does not fire", () => {
    expect(CREDENTIAL_PATH_RULE.evaluate(toolName, args, null)).toBeUndefined();
  });
});
