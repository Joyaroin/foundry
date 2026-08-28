import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type RunOutcome = { ok: boolean; stdout: string; stderr: string; code: number };

/** Run a command, throwing on failure. Use when a non-zero exit is a bug in the run. */
export async function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Run a command, reporting failure instead of throwing. Use for gates, which are expected to fail sometimes. */
export async function tryRun(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<RunOutcome> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message: string };
    return {
      ok: false,
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? err.message).trim(),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

/** Run a shell string from the spoke's config (`npm run typecheck`). Reports failure, never throws. */
export async function tryShell(
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<RunOutcome> {
  if (!env) return tryRun("/bin/sh", ["-c", command], cwd);
  try {
    const { stdout, stderr } = await exec("/bin/sh", ["-c", command], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message: string };
    return {
      ok: false,
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? err.message).trim(),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}
