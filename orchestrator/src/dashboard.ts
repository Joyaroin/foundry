import { createServer } from "node:http";
import { open, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `foundry dashboard` — the run, watched rather than tailed.
 *
 * A build loop is three or four builders working at once, each moving through worktree,
 * setup, narration, merge and four gate commands. That is a *concurrent* thing, and a log
 * is a linear one: by the time three builders are interleaving, the shape of the run —
 * who is where, how long they have been there, what is about to land — is present in the
 * text and legible in none of it.
 *
 * ── The server does no parsing, deliberately ─────────────────────────────────────────
 *
 * It tails a file and streams raw lines. Every rule about what a line *means* lives in the
 * page, so there is one state machine rather than two halves of one that can disagree —
 * the same reason `frontier.ts` is the only thing that decides what is buildable. It also
 * means the log format and the dashboard cannot drift apart silently: a line the page does
 * not recognise is visible as an unstyled line rather than absent.
 *
 * ── Replay, then follow ──────────────────────────────────────────────────────────────
 *
 * A connecting client is sent the whole file before the stream starts, so opening the
 * dashboard ten minutes into a run shows the ten minutes. Growth is detected by polling
 * the file size rather than `fs.watch`, which is unreliable across platforms and reports
 * nothing at all for some editors' write patterns; a build loop's line rate is a few per
 * second at its noisiest, so a 400ms poll is well inside human resolution and costs a
 * `stat` per tick.
 */

const PAGE = fileURLToPath(new URL("./dashboard.html", import.meta.url));
const POLL_MS = 400;

/**
 * Read from `offset` to the end, returning the whole lines found and where to resume.
 *
 * `truncated` is the signal that matters as much as the text: `run` empties this file at the
 * start of every run, so a file that is now *shorter* than where we were reading is not a
 * quiet no-op — it is a different run. Without saying so, a page opened during one run keeps
 * every card and line from it and appends the next run underneath, which is worse than
 * showing nothing.
 */
async function readFrom(
  path: string,
  offset: number,
): Promise<{ text: string; next: number; truncated: boolean }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size < offset) return { text: "", next: 0, truncated: true };
    if (size === offset) return { text: "", next: size, truncated: false };
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString("utf8");

    // Resume at the last newline, so a line still being written is read whole next tick
    // rather than delivered in two halves that each fail to parse.
    const cut = text.lastIndexOf("\n");
    if (cut < 0) return { text: "", next: offset, truncated: false };
    const whole = text.slice(0, cut + 1);
    return { text: whole, next: offset + Buffer.byteLength(whole), truncated: false };
  } finally {
    await handle.close();
  }
}

function sse(res: import("node:http").ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\n`);
  for (const line of data.split("\n")) res.write(`data: ${line}\n`);
  res.write("\n");
}

export async function dashboard(opts: {
  logPath: string;
  port: number;
  log: (msg: string) => void;
}): Promise<void> {
  const { logPath, port, log } = opts;

  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      let offset = 0;
      let stopped = false;

      const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
          await stat(logPath);
          const { text, next, truncated } = await readFrom(logPath, offset);
          offset = next;
          // A new run. The page throws away the last one rather than growing a second
          // history under it, and the next tick replays this run from the top.
          if (truncated) sse(res, "reset", "new run");
          if (text.length > 0) sse(res, "lines", text.replace(/\n$/, ""));
        } catch {
          // The log does not exist yet — a dashboard opened before the run starts is a
          // reasonable thing to do, so this waits rather than failing.
        }
        if (!stopped) setTimeout(() => void tick(), POLL_MS);
      };
      void tick();

      req.on("close", () => {
        stopped = true;
      });
      return;
    }

    // Read the page per request rather than once at boot, so editing it is a refresh
    // rather than a restart.
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(PAGE, "utf8"));
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("dashboard.html is missing beside dashboard.ts");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  log(`dashboard: http://localhost:${port}  watching ${logPath}`);
  log("dashboard: ctrl-c to stop");
  await new Promise(() => {});
}
