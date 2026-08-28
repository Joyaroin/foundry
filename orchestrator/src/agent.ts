import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PLUGIN_PATH } from "./config.js";

/**
 * One agent call. The model decides content; this module decides nothing else.
 *
 * Message shapes are read defensively: the SDK streams several message kinds and
 * adds more over time, so we match the two we depend on ("assistant" for text,
 * "result" for termination) and ignore the rest rather than exhaustively switching.
 */

type Streamed = {
  type: string;
  subtype?: string;
  message?: { content?: unknown[] };
  [k: string]: unknown;
};

export type AgentRun = {
  /** Concatenated assistant text. Useful for logs and failure reports, never parsed for control flow. */
  text: string;
  /** False when the SDK ended the session on an error rather than completing the task. */
  ok: boolean;
  detail: string;
};

export type AgentOptions = {
  cwd: string;
  /** Tools the agent may use without asking. Nothing prompts: an unattended run has nobody to ask. */
  allowedTools?: string[];
  maxTurns?: number;
  /** Hard ceiling in USD for this one call. The SDK aborts past it. */
  maxBudgetUsd?: number;
  onText?: (text: string) => void;
};

const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "Task"];

export async function agent(prompt: string, opts: AgentOptions): Promise<AgentRun> {
  const chunks: string[] = [];
  let ok = true;
  let detail = "completed";

  try {
    for await (const raw of query({
      prompt,
      options: {
        cwd: opts.cwd,
        model: MODEL,
        // The plugin carries every skill the pipeline uses, plus the builder agent.
        plugins: [{ type: "local", path: PLUGIN_PATH }],
        allowedTools: opts.allowedTools ?? DEFAULT_TOOLS,
        // Unattended: there is no human to answer a permission prompt.
        permissionMode: "bypassPermissions",
        // Do not inherit Adham's personal settings; a run must behave the same anywhere.
        settingSources: [],
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      },
    }) as AsyncIterable<Streamed>) {
      if (raw.type === "assistant" && Array.isArray(raw.message?.content)) {
        for (const block of raw.message.content as { type?: string; text?: string }[]) {
          if (typeof block?.text === "string") {
            chunks.push(block.text);
            opts.onText?.(block.text);
          }
        }
      } else if (raw.type === "result") {
        // Anything other than success means the session ended badly, not that the task failed its gates.
        if (raw.subtype && raw.subtype !== "success") {
          ok = false;
          detail = `session ended: ${raw.subtype}`;
        }
      }
    }
  } catch (e) {
    ok = false;
    detail = e instanceof Error ? e.message : String(e);
  }

  return { text: chunks.join("\n").trim(), ok, detail };
}
