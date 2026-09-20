import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";

test("defaults use the local model without borrowing a cloud API key", () => {
  const config = readConfig({ OPENAI_API_KEY: "not-for-local" });
  assert.equal(config.provider, "local");
  assert.equal(config.apiKey, "local-no-key");
  assert.equal(config.baseUrl, "http://127.0.0.1:8089/v1");
});

test("configuration rejects missing credentials, unknown providers, and invalid budgets", () => {
  assert.throws(() => readConfig({ SPIDER_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  assert.throws(() => readConfig({ SPIDER_PROVIDER: "unknown" }), /SPIDER_PROVIDER/);
  assert.throws(() => readConfig({ SPIDER_MAX_STEPS: "-1" }), /maxSteps/);
  assert.throws(() => readConfig({ SPIDER_PROVIDER: "compatible" }), /Invalid configuration/);
});

test("insecure or credential-bearing model URLs are rejected", () => {
  assert.throws(() => readConfig({ SPIDER_BASE_URL: "http://remote.example/v1" }), /HTTPS/);
  assert.throws(() => readConfig({ SPIDER_BASE_URL: "http://user:secret@localhost/v1" }), /credentials/);
  assert.throws(() => readConfig({ SPIDER_BASE_URL: "https://remote.example/v1" }), /loopback/);
});

test("agent data cannot be placed inside the tool workspace", () => {
  assert.throws(() => readConfig({ SPIDER_DATA_DIR: "workspace/data" }), /outside the agent workspace/);
});