/**
 * Hostile resource-path + SSRF tests — P1-01 / P1-02.
 *
 * PATH-ADV-01..03  credential path normalization (dot segments, absolute
 *                  home, file URI, env alias, Windows, alternate stores)
 * SSRF-ADV-01..04  alternate IP encodings and IPv6 forms
 *
 * All checks run through the structural rules (CREDENTIAL_PATH_RULE /
 * SSRF_LOCALHOST_RULE) on the DEFAULT hardened stack semantics.
 */

import { describe, expect, it } from "bun:test";
import { classifyResourcePath } from "./resource-path.js";
import { CREDENTIAL_PATH_RULE, SSRF_LOCALHOST_RULE } from "./sink-policy.js";
import { classifyUrlTarget } from "./url-policy.js";

// ── Unit: normalizeResourcePath / classifyResourcePath ───────────────────────

describe("resource path normalization (P1-01)", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env alias in test name
  it("normalizes ~, ${HOME}, $HOME, and file URIs to the same segments", () => {
    const variants = [
      "~/.ssh/id_rsa",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env alias fixture
      "${HOME}/.ssh/id_rsa",
      "$HOME/.ssh/id_rsa",
      "file:///home/user/.ssh/id_rsa",
    ];
    for (const v of variants) {
      expect(classifyResourcePath(v).isSensitive).toBe(true);
      expect(classifyResourcePath(v).sensitiveClass).toBe("ssh_keys");
    }
  });

  it("resolves dot segments before classifying", () => {
    expect(classifyResourcePath("~/docs/../.ssh/id_rsa").isSensitive).toBe(true);
    expect(classifyResourcePath("~/docs/../../.ssh/../.ssh/id_rsa").isSensitive).toBe(true);
    expect(classifyResourcePath("file:///home/user/./.ssh/id_rsa").isSensitive).toBe(true);
  });

  it("handles Windows-style separators and profiles", () => {
    expect(classifyResourcePath("C:\\Users\\alice\\.ssh\\id_rsa").isSensitive).toBe(true);
    expect(classifyResourcePath("%USERPROFILE%\\.aws\\credentials").isSensitive).toBe(true);
  });

  it("classifies cloud/kube/vcs credential stores", () => {
    expect(
      classifyResourcePath("~/.config/gcloud/application_default_credentials.json").sensitiveClass
    ).toBe("gcloud_credentials");
    expect(classifyResourcePath("file:///home/u/.azure/accessTokens.json").sensitiveClass).toBe(
      "azure_credentials"
    );
    expect(classifyResourcePath("~/.kube/config").sensitiveClass).toBe("kubeconfig");
    expect(classifyResourcePath("~/.git-credentials").sensitiveClass).toBe("vcs_credentials");
    expect(classifyResourcePath("/etc/shadow").sensitiveClass).toBe("unix_accounts");
  });

  it("does not classify benign paths as sensitive", () => {
    for (const p of ["/tmp/notes.txt", "~/projects/index.ts", "/var/log/app.log", "data.csv"]) {
      const c = classifyResourcePath(p);
      expect(c.isSensitive).toBe(false);
    }
  });
});

// ── PATH-ADV-01..03: rule-level hostile paths ────────────────────────────────

describe("PATH-ADV: credential path rule against path normalization attacks", () => {
  const cases: Array<[string, string]> = [
    ["PATH-ADV-01", "~/docs/../.ssh/../.ssh/id_rsa"],
    ["PATH-ADV-02", "/home/ubuntu/.ssh/id_ed25519"],
    ["PATH-ADV-03", "file:///home/ubuntu/.ssh/id_rsa"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env alias fixture
    ["PATH-ADV-03b", "${HOME}/.aws/credentials"],
    ["PATH-ADV-03c", "%USERPROFILE%\\.ssh\\config"],
    ["PATH-ADV-03d", "file://%2Fhome%2Fuser%2F.ssh%2Fid_rsa"],
  ];

  for (const [id, value] of cases) {
    it(`${id}: ${value} → deny`, () => {
      const result = CREDENTIAL_PATH_RULE.evaluate("read_file", { path: value }, null);
      expect(result).toBe("deny");
    });
  }

  it("PATH-ADV-04: hostile path nested in a renamed argument object → deny", () => {
    const result = CREDENTIAL_PATH_RULE.evaluate(
      "sync",
      { wrapper: { target: "~/.ssh/id_rsa" } },
      null
    );
    expect(result).toBe("deny");
  });

  it("PATH-ADV-05: benign path → undefined (rule skips)", () => {
    expect(
      CREDENTIAL_PATH_RULE.evaluate("read_file", { path: "/tmp/a.txt" }, null)
    ).toBeUndefined();
  });
});

// ── Unit: classifyUrlTarget encodings ────────────────────────────────────────

describe("URL target classification (P1-02)", () => {
  it("SSRF-ADV-01: 127.0.0.0/8 range (127.0.0.2) blocked", () => {
    expect(classifyUrlTarget("http://127.0.0.2/admin").blocked).toBe(true);
  });

  it("SSRF-ADV-02: IPv6 ::1 blocked", () => {
    expect(classifyUrlTarget("http://[::1]:8080/").blocked).toBe(true);
  });

  it("SSRF-ADV-03: IPv4-mapped IPv6 ::ffff:127.0.0.1 blocked", () => {
    expect(classifyUrlTarget("http://[::ffff:127.0.0.1]/").blocked).toBe(true);
    expect(classifyUrlTarget("http://[::ffff:a00:1]/").blocked).toBe(true); // ::ffff:10.0.0.1
  });

  it("SSRF-ADV-04: alternate IPv4 encodings blocked", () => {
    expect(classifyUrlTarget("http://2130706433/").blocked).toBe(true); // 127.0.0.1 decimal
    expect(classifyUrlTarget("http://0x7f000001/").blocked).toBe(true); // hex
    expect(classifyUrlTarget("http://0177.0.0.1/").blocked).toBe(true); // octal octet
    expect(classifyUrlTarget("http://169.254.169.254/latest/meta-data/").blocked).toBe(true);
  });

  it("private ranges and metadata names blocked", () => {
    for (const u of [
      "http://10.1.2.3/",
      "http://172.16.0.9/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://localhost:3000/",
      "http://db.localhost/",
    ]) {
      expect(classifyUrlTarget(u).blocked).toBe(true);
    }
  });

  it("public hosts and prose are not blocked", () => {
    for (const u of [
      "https://api.example.com/v1",
      "https://collector.example.com/ingest",
      "just some prose about localhost history",
    ]) {
      expect(classifyUrlTarget(u).blocked).toBe(false);
    }
  });
});

// ── SSRF-ADV rule level ──────────────────────────────────────────────────────

describe("SSRF-ADV: rule-level alternate encodings", () => {
  const cases: Array<[string, string]> = [
    ["SSRF-ADV-01", "http://127.0.0.2:8080/admin"],
    ["SSRF-ADV-02", "http://[::1]/health"],
    ["SSRF-ADV-03", "http://[::ffff:127.0.0.1]/health"],
    ["SSRF-ADV-04", "http://0x7f.0.0.1/nexthop"],
  ];

  for (const [id, value] of cases) {
    it(`${id}: ${value} → deny`, () => {
      const result = SSRF_LOCALHOST_RULE.evaluate("http_request", { url: value }, null);
      expect(result).toBe("deny");
    });
  }

  it("SSRF-ADV-05: nested URL value under renamed arg → deny", () => {
    const result = SSRF_LOCALHOST_RULE.evaluate(
      "http_request",
      { options: { callback: "http://169.254.169.254/latest/meta-data/" } },
      null
    );
    expect(result).toBe("deny");
  });

  it("SSRF-ADV-06: public URL → undefined (rule skips)", () => {
    expect(
      SSRF_LOCALHOST_RULE.evaluate("http_request", { url: "https://api.example.com" }, null)
    ).toBeUndefined();
  });
});
