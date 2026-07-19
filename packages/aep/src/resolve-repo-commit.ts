import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export async function resolveRepoCommit(options?: {
  envVar?: string;
  cwd?: string;
  fallbackToVersion?: boolean;
}): Promise<string> {
  const envVar = options?.envVar ?? "AEP_REPO_COMMIT";
  const cwd = options?.cwd ?? process.cwd();
  const fallbackToVersion = options?.fallbackToVersion ?? true;

  const envValue = process.env[envVar];
  if (envValue) return envValue;

  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (sha) return sha;
  } catch {
    /* not a git repo or git not available */
  }

  if (fallbackToVersion) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      if (pkg.version) return `v${pkg.version}`;
    } catch {
      /* no package.json */
    }
  }

  return "unknown";
}
