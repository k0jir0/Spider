import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { createSpiderAgent } from "../src/agent.js";

test("the real agent graph executes a model-selected tool and returns its result", async () => {
  let calls = 0;
  let toolExecuted = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: { role: string; content: string }[];
    };
    calls += 1;
    const toolResult = body.messages.find((message) => message.role === "tool");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: `test-${calls}`,
      object: "chat.completion",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        finish_reason: toolResult ? "stop" : "tool_calls",
        message: toolResult
          ? { role: "assistant", content: `The result is ${toolResult.content}.` }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "multiply", arguments: '{"left":6,"right":7}' },
              }],
            },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const model = new ChatOpenAI({
      model: "test-model",
      apiKey: "test-only",
      maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` },
    });
    const multiply = tool(({ left, right }) => {
      toolExecuted = true;
      return String(left * right);
    }, {
      name: "multiply",
      description: "Multiply two numbers.",
      schema: z.object({ left: z.number(), right: z.number() }),
    });
    const agent = createSpiderAgent(model, [multiply]);
    const result = await agent.invoke({ messages: [{ role: "user", content: "Multiply 6 by 7." }] }, {
      recursionLimit: 6,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(toolExecuted, true);
    assert.equal(calls, 2);
    assert.equal(result.messages.at(-1)?.content, "The result is 42.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});