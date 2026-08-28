import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which credential the run will use.
 *
 * The Agent SDK resolves this itself; this module only reports what it will find, so
 * preflight can refuse a run that would die on auth twenty minutes in rather than at the start.
 * Verified 2026-08-27: with no ANTHROPIC_API_KEY set, a query() call authenticated off the
 * existing Claude Code OAuth credentials and returned success.
 */

export type Credential =
  | { kind: "api-key"; detail: string }
  | { kind: "oauth-token"; detail: string }
  | { kind: "claude-code-oauth"; detail: string }
  | { kind: "none"; detail: string };

function credentialsFile(): string {
  const dir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  return join(dir, ".credentials.json");
}

export function credential(): Credential {
  if (process.env["ANTHROPIC_API_KEY"]) {
    return { kind: "api-key", detail: "ANTHROPIC_API_KEY — billed at API rates" };
  }
  if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    return { kind: "oauth-token", detail: "CLAUDE_CODE_OAUTH_TOKEN — long-lived token from `claude setup-token`" };
  }

  const path = credentialsFile();
  if (existsSync(path)) {
    try {
      const creds = JSON.parse(readFileSync(path, "utf8")) as {
        claudeAiOauth?: { expiresAt?: number; subscriptionType?: string };
      };
      const oauth = creds.claudeAiOauth;
      if (oauth) {
        const sub = oauth.subscriptionType ? ` (${oauth.subscriptionType})` : "";
        // Expiry is informational: the SDK refreshes with the refresh token.
        const expired = typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now();
        return {
          kind: "claude-code-oauth",
          detail: `Claude Code OAuth${sub}${expired ? " — access token expired, the SDK will refresh it" : ""}`,
        };
      }
    } catch {
      // A malformed credentials file is the same as none for our purposes.
    }
  }

  return {
    kind: "none",
    detail:
      `no credential found. Either log in to Claude Code, run \`claude setup-token\` and export ` +
      `CLAUDE_CODE_OAUTH_TOKEN, or export ANTHROPIC_API_KEY.`,
  };
}
