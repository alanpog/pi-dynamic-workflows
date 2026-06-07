/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that resolves invocation arguments, asks the user to confirm the full
 * invocation, then runs the script with the resolved args.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { createCodingTools, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, SavedWorkflowParameter, WorkflowStorage } from "./workflow-saved.js";

function isRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result as { report?: unknown } | undefined;
  if (r && typeof r.report === "string" && r.report.trim()) return r.report;
  return JSON.stringify(result.result, null, 2);
}

function splitRawArgs(raw: string): { explicit: Record<string, unknown>; positional: string[] } {
  const explicit: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) explicit[tok.slice(0, eq)] = tok.slice(eq + 1);
    else positional.push(tok);
  }
  return { explicit, positional };
}

/**
 * Parse a command argument string into an `args` object for the script.
 * Supports `key=value` tokens; everything else collects into `_` (and `_raw`).
 * Declared parameter defaults fill in missing keys.
 */
export function parseCommandArgs(raw: string, parameters?: SavedWorkflow["parameters"]): Record<string, unknown> {
  const { explicit, positional } = splitRawArgs(raw);
  const out: Record<string, unknown> = { ...explicit };
  out._ = positional.join(" ");
  out._raw = raw.trim();
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

function parameterKeys(wf: SavedWorkflow): string[] {
  return Object.keys(wf.parameters ?? {});
}

function requiredParameterKeys(wf: SavedWorkflow): string[] {
  return Object.entries(wf.parameters ?? {})
    .filter(([, spec]) => spec.required)
    .map(([key]) => key);
}

function applyParameterDefaults(
  params: Record<string, unknown>,
  parameters?: SavedWorkflow["parameters"],
): Record<string, unknown> {
  const out = { ...params };
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

function missingRequiredParams(params: Record<string, unknown>, wf: SavedWorkflow): string[] {
  return requiredParameterKeys(wf).filter((key) => {
    const value = params[key];
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });
}

function choosePrimaryParameter(wf: SavedWorkflow): string | undefined {
  if (wf.primaryParameter && wf.parameters?.[wf.primaryParameter]) return wf.primaryParameter;
  const entries = Object.entries(wf.parameters ?? {});
  const requiredStrings = entries.filter(([, spec]) => spec.required && (spec.type ?? "string") === "string");
  if (requiredStrings.length === 1) return requiredStrings[0][0];
  const strings = entries.filter(([, spec]) => (spec.type ?? "string") === "string");
  if (strings.length === 1) return strings[0][0];
  return undefined;
}

function describeParameter(spec: SavedWorkflowParameter): Record<string, unknown> {
  return {
    type: spec.type ?? "string",
    required: !!spec.required,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.default !== undefined ? { default: spec.default } : {}),
    ...(spec.enum ? { enum: spec.enum } : {}),
  };
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) return undefined;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function interpretWithModel(
  raw: string,
  explicit: Record<string, unknown>,
  wf: SavedWorkflow,
  ctx: ExtensionCommandContext,
): Promise<Record<string, unknown> | undefined> {
  if (!ctx.model) return undefined;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) return undefined;
    const parameters = Object.fromEntries(
      Object.entries(wf.parameters ?? {}).map(([key, spec]) => [key, describeParameter(spec)]),
    );
    const prompt = [
      `Interpret a saved Pi workflow invocation as JSON parameters.`,
      `Workflow: /${wf.name}`,
      `Description: ${wf.description || wf.name}`,
      wf.argumentHint ? `Guidance: ${wf.argumentHint}` : undefined,
      `Parameter schema: ${JSON.stringify(parameters)}`,
      `Explicit key=value parameters already supplied and must be preserved unless invalid: ${JSON.stringify(explicit)}`,
      `Natural-language invocation text: ${JSON.stringify(raw.trim())}`,
      `Return ONLY a JSON object containing the parameter values. Do not include prose.`,
    ]
      .filter(Boolean)
      .join("\n");
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };
    const response = await complete(
      ctx.model,
      {
        systemPrompt: "You convert natural language into workflow parameters. Return strict JSON only.",
        messages: [userMessage],
      },
      { apiKey: auth.apiKey, headers: auth.headers },
    );
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const interpreted = extractJsonObject(text);
    return interpreted ? { ...interpreted, ...explicit } : undefined;
  } catch {
    return undefined;
  }
}

function interpretHeuristically(
  explicit: Record<string, unknown>,
  positional: string[],
  wf: SavedWorkflow,
): Record<string, unknown> | undefined {
  const text = positional.join(" ").trim();
  if (!text) return { ...explicit };
  const primary = choosePrimaryParameter(wf);
  if (!primary) return undefined;
  return { [primary]: text, ...explicit };
}

export interface ResolvedWorkflowInvocation {
  args: Record<string, unknown>;
  missing: string[];
  ambiguous: boolean;
}

/** Resolve explicit key=value args plus natural language into structured workflow params. */
export async function resolveWorkflowInvocation(
  raw: string,
  wf: SavedWorkflow,
  ctx: ExtensionCommandContext,
): Promise<ResolvedWorkflowInvocation> {
  const { explicit, positional } = splitRawArgs(raw);
  const hasParameters = parameterKeys(wf).length > 0;
  let params: Record<string, unknown>;

  if (!hasParameters) {
    params = parseCommandArgs(raw, wf.parameters);
  } else if (positional.length === 0) {
    params = { ...explicit };
  } else {
    params = (await interpretWithModel(raw, explicit, wf, ctx)) ??
      interpretHeuristically(explicit, positional, wf) ?? {
        ...explicit,
      };
  }

  params = applyParameterDefaults(params, wf.parameters);
  const missing = missingRequiredParams(params, wf);
  const ambiguous = hasParameters && positional.length > 0 && missing.length > 0 && !choosePrimaryParameter(wf);
  return { args: params, missing, ambiguous };
}

function invocationPreview(wf: SavedWorkflow, args: Record<string, unknown>): string {
  return [`Run /${wf.name} with:`, "", JSON.stringify(args, null, 2)].join("\n");
}

async function confirmInvocation(
  wf: SavedWorkflow,
  args: Record<string, unknown>,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  if (!ctx.hasUI || !ctx.ui.confirm) {
    ctx.ui.notify(`/${wf.name} needs confirmation before running; interactive UI is required.`, "warning");
    return false;
  }
  return ctx.ui.confirm("Run workflow?", invocationPreview(wf, args));
}

function attachManagerStatus(
  manager: WorkflowManager,
  runId: string,
  wf: SavedWorkflow,
  ctx: ExtensionCommandContext,
): void {
  ctx.ui.setStatus(`wf:${wf.name}`, `${wf.name}: running (${runId})`);
  const clear = (event: { runId?: string }) => {
    if (event?.runId && event.runId !== runId) return;
    ctx.ui.setStatus(`wf:${wf.name}`, undefined);
    manager.off?.("complete", clear);
    manager.off?.("error", clear);
    manager.off?.("stopped", clear);
  };
  manager.on?.("complete", clear);
  manager.on?.("error", clear);
  manager.on?.("stopped", clear);
}

/** Register one saved workflow as a `/<name>` command (idempotent).
 * When a WorkflowManager is provided, the workflow runs through it (visible in
 * /workflows TUI, background execution, task panel). Otherwise falls back to
 * the inline runWorkflow() (foreground, no TUI tracking).
 *
 * Pi has no `unregisterCommand`, so a command cannot be removed mid-session
 * after its workflow is deleted (it is correctly gone on next launch, since
 * registerAllSavedWorkflows only registers what's in storage). The optional
 * `exists` predicate lets the handler detect that case at invocation time and
 * tell the user to reload rather than silently re-running a deleted workflow. */
export function registerSavedWorkflow(
  pi: ExtensionAPI,
  cwd: string,
  wf: SavedWorkflow,
  manager?: WorkflowManager,
  exists?: () => boolean,
): void {
  if (isRegistered(pi, wf.name)) return;
  pi.registerCommand(wf.name, {
    description: wf.description || `Saved workflow: ${wf.name}`,
    async handler(args: string, ctx: ExtensionCommandContext) {
      if (exists && !exists()) {
        ctx.ui.notify(`/${wf.name} was deleted — reload the session to remove this command.`, "warning");
        return;
      }
      try {
        const resolved = await resolveWorkflowInvocation(args, wf, ctx);
        if (resolved.ambiguous) {
          ctx.ui.notify(
            `/${wf.name} could not map your text to parameters. Use key=value args or add a primaryParameter.`,
            "warning",
          );
          return;
        }
        if (resolved.missing.length > 0) {
          ctx.ui.notify(`/${wf.name} needs parameter(s): ${resolved.missing.join(", ")}.`, "warning");
          return;
        }
        if (!(await confirmInvocation(wf, resolved.args, ctx))) {
          ctx.ui.notify(`Cancelled /${wf.name}.`, "info");
          return;
        }

        if (manager) {
          // Start through the WorkflowManager and return immediately. Result
          // delivery is handled by installResultDelivery/task panel listeners.
          const { runId, promise } = manager.startInBackground(wf.script, resolved.args);
          attachManagerStatus(manager, runId, wf, ctx);
          promise.catch((error) => {
            ctx.ui.notify(`/${wf.name} failed: ${error instanceof Error ? error.message : error}`, "error");
          });
          ctx.ui.notify(`Started /${wf.name} in the background (${runId}).`, "info");
          return;
        }

        ctx.ui.notify(`Starting /${wf.name}…`, "info");
        const result = await runWorkflow(wf.script, {
          cwd,
          args: resolved.args,
          tools: createCodingTools(cwd),
          onPhase: (title) => ctx.ui.setStatus(`wf:${wf.name}`, `${wf.name}: ${title}`),
        });
        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        await pi.sendMessage({ customType: `workflow:${wf.name}`, content: reportText(result), display: true });
      } catch (error) {
        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        ctx.ui.notify(`/${wf.name} failed: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
}

/** Register every saved workflow found in storage.
 * When a WorkflowManager is provided, workflows run through it (visible in
 * /workflows TUI, background execution, task panel). */
export function registerAllSavedWorkflows(
  pi: ExtensionAPI,
  cwd: string,
  storage: WorkflowStorage,
  manager?: WorkflowManager,
): void {
  for (const wf of storage.list()) {
    registerSavedWorkflow(pi, cwd, wf, manager, () => storage.list().some((w) => w.name === wf.name));
  }
}
