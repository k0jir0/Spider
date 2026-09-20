# Spider

A local-first, tool-using AI agent controlled from a CLI. It reads and searches a bounded workspace, performs arithmetic, optionally creates files, and remembers conversations across processes. Model decisions run through LangChain's LangGraph-backed agent loop, not a scripted demo.

## Run on Windows

From this folder:

```powershell
.\setup.cmd
.\spider.cmd doctor
.\spider.cmd demo --allow-write
.\spider.cmd chat
```

Setup installs portable Node.js 22 LTS, locked npm dependencies, llama.cpp CPU build `b10964`, and the official Qwen3-1.7B Q8_0 model inside this project. No administrator access, GPU, Docker, API key, or paid account is required. Initial downloads include approximately 1.7 GiB of model weights; reserve 4 GiB of disk space and several GiB of available RAM. Internet access is needed for setup, not default local inference.

If setup has already been completed, go directly to `spider.cmd`. With no arguments in an interactive terminal it opens chat. The launcher works from other directories too. It starts the local model when needed and stops the process it started on exit; it does not stop an already-running compatible local server.

Node's SQLite module emits an `ExperimentalWarning` on Node 22. This is expected; SQLite is exercised by the test suite. The scripts only bypass PowerShell execution policy for their own process, without changing user or machine policy.

## Commands

```powershell
.\spider.cmd run "Use calculate to multiply 37 by 19."
.\spider.cmd run "Read demo/invoice.json and calculate the total." --session invoices
.\spider.cmd run "What was the total?" --session invoices
.\spider.cmd chat --session research --allow-write
.\spider.cmd demo --allow-write --json
.\spider.cmd sessions
.\spider.cmd history invoices
.\spider.cmd runs --session invoices
.\spider.cmd trace RUN_ID
.\spider.cmd --help
```

`--json` keeps results on stdout and progress on stderr. Errors exit nonzero. `--allow-write` is required to expose the write tool and applies only to the current invocation. Writes create new files exclusively; the agent cannot overwrite or delete existing files. Chat supports `/exit`, `/new`, and `/session NAME`. Ctrl+C cancels the invocation.

Place your text files under [workspace](workspace). Paths used by tools are relative to that directory. `--workspace PATH` selects a different root; relative roots are resolved from the project directory. The data directory must remain outside the tool workspace.

## Providers

Copy [.env.example](.env.example) to `.env` to persist configuration, or set environment variables. Process environment values take precedence. Global flags `--provider`, `--model`, and `--workspace` override their corresponding environment settings. API keys are never requested through the CLI or stored in source.

| Provider | Default model | Default endpoint | Setup |
| --- | --- | --- | --- |
| `local` | `spider-local` (installed Qwen3-1.7B) | `http://127.0.0.1:8089/v1` | `setup.cmd` |
| `ollama` | `qwen3:4b` | `http://127.0.0.1:11434/v1` | Install/start Ollama and run `ollama pull qwen3:4b` |
| `openai` | `gpt-4.1-mini` | `https://api.openai.com/v1` | Set `OPENAI_API_KEY` privately |
| `compatible` | Explicit `SPIDER_MODEL` | Explicit `SPIDER_BASE_URL` | A tool-capable OpenAI-compatible chat service |

```powershell
.\spider.cmd --provider ollama --model qwen3:4b chat
.\spider.cmd --provider openai run "Use calculate to multiply 37 by 19."
```

External services and API keys are not bundled. OpenAI can incur usage charges; files and conversation content sent to a remote provider leave this machine. A session cannot be reused with a different provider, endpoint, or model, preventing accidental history transfer. Use a fresh session when switching providers. Use `setup.cmd --skip-model` when you only want an external provider.

For another OpenAI-compatible service, set `SPIDER_PROVIDER=compatible`, `SPIDER_MODEL`, `SPIDER_BASE_URL`, and optionally `SPIDER_API_KEY`. HTTPS is required except on loopback. If local port 8089 is occupied, set `SPIDER_BASE_URL=http://127.0.0.1:8090/v1` to select another loopback port.

## Boundaries And Storage

- Available tools: `list_files`, `read_file`, `search_files`, `calculate`, and opt-in `write_file`.
- Reads and writes are limited to 16 KiB text files. Listings/searches inspect at most 100 entries; search is non-recursive and returns at most 20 matches.
- Parent traversal, hidden paths, symbolic links, directory junctions, hard-linked files, and Windows special paths are rejected. There is no shell, deletion, arbitrary code execution, or network-fetch tool.
- These are application-level controls, not an OS sandbox. Do not concurrently mutate the workspace with an untrusted process; filesystem race attacks are outside this protection boundary. Review model-created content before using it.
- `SPIDER_MAX_STEPS` limits graph execution steps, not just model calls; `SPIDER_TIMEOUT_MS` bounds a task; `SPIDER_MAX_TOKENS` bounds each model response. Defaults are 16 steps, 120 seconds, and 1024 output tokens.
- Complete history is saved locally, but only the last four complete turns fitting a 16,000-character serialized context budget are supplied to the model. Older turns can be inspected with `history`; this is not unlimited model memory.
- `.spider/spider.sqlite` stores prompts, messages, tool inputs/results, usage, and run status in plaintext. Keep it private. Concurrent requests to one session are refused; expired run leases permit recovery after a crash.
- Failed turns do not replace successful conversation history. Their audit events remain. A completed run means the loop produced a final answer, not that its answer is necessarily correct. Tool side effects are not rolled back on cancellation or failure, and interrupted runs are not automatically resumed.
- Default local inference uses no cloud service. LangSmith tracing is not configured here; existing tracing-related environment variables from another project may enable it through LangChain.

## Development And Verification

With Node.js 22.16+ and npm already on PATH:

```powershell
npm ci
npm run build
npm test
npm run smoke
npm start -- doctor
```

To use the bundled runtime in the current PowerShell session:

```powershell
$env:Path = "$PWD\.runtime\node;$env:Path"
npm test
npm run smoke
```

`npm test` runs offline tests using a scripted HTTP model only in the test harness. It exercises the real agent framework, provider protocol, tool boundaries, database persistence, failure handling, budgets, and the CLI. It does not prove real-model quality.

`npm run smoke` uses the actual downloaded model and an isolated temporary workspace. It asserts ordered file-read/calculation/write operations, the correct `Local Workshop / 703 CAD` artifact, recall after restarting the CLI, and local-server cleanup. It writes a detailed report to `.spider/verification.json`. This check can take a few minutes on CPU and does not call a paid provider.

For a model error, inspect `runs`, then `trace RUN_ID`; startup diagnostics are in `.spider/llama-server.log`. Small models can choose wrong tools or invent facts; prefer a stronger Ollama or hosted model for demanding work. No fallback silently substitutes fake output for unavailable inference.

## Structure

| Path | Responsibility |
| --- | --- |
| [src/cli.ts](src/cli.ts) | Commands, interactive chat, cancellation |
| [src/agent.ts](src/agent.ts) | LangGraph-backed agent definition |
| [src/runner.ts](src/runner.ts) | Provider client, execution budgets, history, usage |
| [src/tools.ts](src/tools.ts) | Bounded workspace capabilities |
| [src/store.ts](src/store.ts) | SQLite sessions and audit records |
| [src/local-model.ts](src/local-model.ts) | Loopback model lifecycle and health checks |
| [scripts](scripts) | Verified setup and real-model smoke check |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Research sources and selection rationale |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Observed test results and remaining limitations |

The original [index.txt](index.txt) request is preserved.