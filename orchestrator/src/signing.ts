import { tryRun } from "./sh.js";

/**
 * Will this run's commits be verified on GitHub?
 *
 * A builder commits like any developer, so it inherits whatever git config the spoke repo resolves
 * to. That is almost always right — but a *local* override silently beats correct global settings,
 * and nothing about an unattended run surfaces it. `harness-fixture` carried `user.email=f@f` from
 * an earlier project; every commit foundry made there landed `Unverified` with reason `no_user`,
 * and it was only noticed by reading the repo on github.com afterwards.
 *
 * These are warnings, not preconditions. Plenty of repos legitimately do not sign, and refusing a
 * run over it would be foundry deciding a policy question that belongs to the repo.
 */

async function config(key: string, cwd: string, scope?: "--global"): Promise<string | null> {
  const args = scope ? ["config", scope, "--get", key] : ["config", "--get", key];
  const r = await tryRun("git", args, cwd);
  return r.ok && r.stdout ? r.stdout : null;
}

export async function signingWarnings(repoDir: string): Promise<string[]> {
  const warnings: string[] = [];

  const gpgsign = await config("commit.gpgsign", repoDir);
  if (gpgsign !== "true") {
    warnings.push(
      "commit.gpgsign is not true here — this run's commits will land unsigned, and GitHub will " +
        "show them as Unverified.",
    );
  }

  const effectiveEmail = await config("user.email", repoDir);
  const globalEmail = await config("user.email", repoDir, "--global");
  if (effectiveEmail && globalEmail && effectiveEmail !== globalEmail) {
    warnings.push(
      `this repo overrides user.email to ${effectiveEmail} (global is ${globalEmail}). If that ` +
        "address is not on your GitHub account, every commit lands Unverified with reason no_user.",
    );
  }
  if (!effectiveEmail) {
    warnings.push("user.email is unset — git will guess an address, and GitHub will not verify it.");
  }

  return warnings;
}
