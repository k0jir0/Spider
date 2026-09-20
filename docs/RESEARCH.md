# Stack Research

Research and local validation: 2026-09-19. Goal: an actual tool-using agent in this folder that can run from a Windows CLI, including a working model, without requiring a cloud account.

## Selected Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime | TypeScript, Node.js 22 LTS | A portable Windows runtime, native HTTP/CLI/process APIs, strict type checks, and a built-in test runner |
| Orchestration | LangChain `createAgent`, backed by LangGraph | Maintained model/tool/result loop, protocol handling, state, cancellation, and bounded graph execution |
| Model API | `@langchain/openai` Chat Completions | One tool-calling protocol for llama.cpp, Ollama, OpenAI, and compatible services |
| Default inference | Official llama.cpp Windows x64 CPU build `b10964` | Portable 18 MiB engine archive, loopback binding, GGUF support, no GPU or system service prerequisite |
| Default weights | Official Qwen3-1.7B Q8_0 | Local tool-capable model, approximately 1.7 GiB download; larger than the rejected 0.6B candidate but still practical on CPU |
| Tool contracts | Zod | Runtime argument validation paired with model-readable tool schemas |
| Interface | Commander and Node readline | One-shot scripting, parseable JSON, interactive sessions, and diagnostics without a web deployment |
| Persistence | Node `node:sqlite` | Transactions and cross-process session leases without a database server or native npm extension |
| Verification | Node test runner plus live-model smoke script | Separates deterministic protocol/security checks from actual model-quality validation |

Exact npm versions are recorded in `package-lock.json`. The engine build is pinned; the installer resolves model metadata and downloads from an immutable Hugging Face commit URL. `.runtime/local-model.json` records the installed revision and SHA256 digests. Node archives, engine archives, and weights are checked against hashes from their official HTTPS metadata sources. This is integrity verification, not a claim of independent publisher-signature verification.

## Primary Sources

1. [LangChain JavaScript agents](https://docs.langchain.com/oss/javascript/langchain/agents): `createAgent`, model/tool loops, state, invocation, and execution controls.
2. [LangChain ChatOllama integration](https://docs.langchain.com/oss/javascript/integrations/chat/ollama): local model support and the requirement to choose a tool-capable model.
3. [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling): multi-turn calls and returning tool results to the model before subsequent decisions.
4. [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md): OpenAI-style tool calls through `llama-server`, tool-aware templates, and the `--jinja` flag.
5. [Official llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases): the published Windows CPU assets and their SHA256 metadata. At research time the latest semantic release pointed to a nightly build using `nightly-tag.txt`; the installer supports that indirection.
6. [Official Qwen3-0.6B GGUF model card](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF): small-model availability, tool use, non-thinking mode, and quantization guidance. This was evaluated but rejected as the default based on observed task errors.
7. [Official Qwen3-1.7B GGUF distribution](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF): the selected weights and immutable revision/checksum metadata used by setup.
8. [Node.js SQLite API](https://nodejs.org/docs/latest-v22.x/api/sqlite.html): embedded transactional storage. The Node 22 API remains marked experimental; this tradeoff is explicitly documented rather than hidden.

## Alternatives And Scope

Ollama is a useful supported alternative, especially for larger models or an existing installation. It was not installed on the target machine, so a portable CPU-only llama.cpp archive was a smaller bootstrap dependency than introducing a separate model-service installation. Both remain accessible through the same model adapter.

A handwritten API loop could reduce dependencies, but would duplicate framework responsibilities around message/tool pairing, graph limits, and error handling. This project uses the maintained loop and implements only its workspace policy, persistence boundary, and CLI.

A web frontend, Docker deployment, database service, vector database, browser automation, and a fleet of role-playing agents were not required to satisfy a local functioning CLI stack. They add setup or authority without a demonstrated need here. One agent with explicit tools is still agentic: the model selects each action, receives its actual result, and decides what to do next.

SQLite provides durable completed-turn conversation memory and tool audit records. It is not being presented as native LangGraph crash-resume checkpointing. Full turn history is retained for inspection while model context is bounded by complete-turn trimming.

## Empirical Model Selection

The 0.6B candidate executed tools but invented invoice contents, including a customer name and total not in the input file. In one observed run it batched dependent read, calculate, and write calls before receiving the read result. That was a failed correctness test, despite a successful process exit.

The provider client now requests `parallel_tool_calls: false`, and the agent is instructed to wait for each observed result. The default was upgraded to 1.7B. The live smoke gate independently checks the audit event order and artifact contents, so a plausible answer or successful exit alone cannot pass it. Runtime success reports are generated in `.spider/verification.json`, not hard-coded into the CLI.

## Limitations

The bundled CPU model is a starter, not a promise of production-grade autonomous reasoning. Models may ignore instructions; keep write access explicit and review generated content. Application-level path checks do not replace an OS sandbox against another malicious process on the host. Remote providers, third-party tracing, and stronger external model installations need separate configuration and were not prerequisites for local setup.