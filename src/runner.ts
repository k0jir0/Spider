import { isAIMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createSpiderAgent } from "./agent.js";
import { backendIdentity, type Config } from "./config.js";
import { SessionStore } from "./store.js";
import { createWorkspaceTools, type ToolEvent } from "./tools.js";

export function messageText(message: BaseMessage): string {
  return typeof message.content === "string" ? message.content
    : message.content.map((block) => typeof block === "string" ? block : "text" in block ? String(block.text) : "").join("\n");
}

export function recentHistory(messages: BaseMessage[]): BaseMessage[] {
  const starts = messages.flatMap((message, index) => message.getType() === "human" ? [index] : []);
  let selected = starts.slice(-4);
  while (selected.length && messages.slice(selected[0]).reduce((size, message) => size + JSON.stringify(message).length, 0) > 16_000) {
    selected = selected.slice(1);
  }
  return selected.length ? messages.slice(selected[0]) : [];
}

export interface RunResult {
  runId: string;
  session: string;
  provider: string;
  model: string;
  answer: string;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runTask(config: Config, store: SessionStore, options: {
  prompt: string;
  session: string;
  allowWrite?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: ToolEvent) => void;
}): Promise<RunResult> {
  const prompt = options.prompt.trim();
  if (!prompt || prompt.length > 8000) throw new Error("Tasks must contain 1-8000 characters.");
  const runId = store.beginRun(options.session, backendIdentity(config), prompt, config.timeoutMs);
  const started = Date.now();
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(config.timeoutMs)])
    : AbortSignal.timeout(config.timeoutMs);
  let toolCalls = 0;
  let toolErrors = 0;
  try {
    const tools = await createWorkspaceTools(config.workspace, options.allowWrite, (event) => {
      if (event.phase === "start") signal.throwIfAborted();
      store.appendEvent(runId, event);
      if (event.phase === "start") toolCalls += 1;
      if (event.phase === "end" && !event.ok) toolErrors += 1;
      options.onEvent?.(event);
    });
    const model = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      configuration: { baseURL: config.baseUrl },
      modelKwargs: { parallel_tool_calls: false },
      temperature: 0.2,
      maxTokens: config.maxTokens,
      timeout: config.timeoutMs,
      maxRetries: 0,
      useResponsesApi: false,
    });
    const history = store.history(options.session);
    const context = recentHistory(history);
    const agent = createSpiderAgent(model, tools);
    const result = await agent.invoke({ messages: [...context, { role: "user", content: prompt }] }, {
      recursionLimit: config.maxSteps,
      signal,
    });
    signal.throwIfAborted();
    const final = result.messages.at(-1);
    if (!final || !isAIMessage(final) || final.tool_calls?.length || !messageText(final).trim()) {
      throw new Error("The model did not produce a final answer. Try a shorter task or a stronger model.");
    }
    const added = result.messages.slice(context.length);
    const usage = added.reduce((total, message) => {
      if (isAIMessage(message) && message.usage_metadata) {
        total.inputTokens += message.usage_metadata.input_tokens;
        total.outputTokens += message.usage_metadata.output_tokens;
      }
      return total;
    }, { inputTokens: 0, outputTokens: 0 });
    store.completeRun(runId, [...history, ...added], usage);
    return {
      runId, session: options.session, provider: config.provider, model: config.model,
      answer: messageText(final), toolCalls, toolErrors, durationMs: Date.now() - started, usage,
    };
  } catch (error) {
    const message = signal.aborted
      ? "Run cancelled or timed out. Completed tool actions are not rolled back."
      : (error instanceof Error ? error.message : String(error)).replaceAll(config.apiKey, "[redacted]");
    store.failRun(runId, message);
    throw new Error(`${message} (run ${runId})`);
  }
}