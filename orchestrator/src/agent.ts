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
  structured_output?: unknown;
  [k: string]: unknown;
};

export type AgentRun = {
  /** Concatenated assistant text. Useful for logs and failure reports, never parsed for control flow. */
  text: string;
  /**
   * The schema-validated object, when `schema` was passed. The SDK enforces the shape and
   * retries the model on a mismatch, so this is either the right shape or absent — control
   * flow never has to interpret prose to find out what happened.
   */
  structured?: unknown;
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
  /** JSON Schema the final answer must match. The SDK validates and retries; we never parse prose. */
  schema?: Record<string, unknown>;
  /** Extra environment for this agent, merged over the parent's. Per-builder resource isolation. */
  env?: Record<string, string>;
  onText?: (text: string) => void;
};

const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "Task"];

export async function agent(prompt: string, opts: AgentOptions): Promise<AgentRun> {
  const chunks: string[] = [];
  let structured: unknown;
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
        ...(opts.schema ? { outputFormat: { type: "json_schema" as const, schema: opts.schema } } : {}),
        ...(opts.env ? { env: { ...process.env, ...opts.env } as Record<string, string> } : {}),
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
        if (raw.structured_output !== undefined) structured = raw.structured_output;
        // Anything other than success means the session ended badly, not that the task failed its gates.
        // `error_max_structured_output_retries` means the model could not satisfy the schema.
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

  return { text: chunks.join("\n").trim(), ...(structured !== undefined ? { structured } : {}), ok, detail };
}
