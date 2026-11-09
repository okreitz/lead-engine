# `claude` CLI: headless usage for the `claude-cli` LLM adapter

Verified on **2026-11-08** against **Claude Code 2.1.319** (`claude --version`) in a Linux container, and against the current docs:
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Headless / programmatic usage: https://code.claude.com/docs/en/headless

Status per flag:
- **run**: executed here and the behaviour observed.
- **docs**: listed in `claude --help` and/or the docs, but not executed in this check.

Ground Control's file (CLI 2.1.301, 2026-11-02) was **not** copied; everything below was rechecked.

## The invocation the adapter uses

`apps/engine/src/llm/claude-cli.ts` runs this through `commands.ts`, as an argument array with no shell. The prompt goes in on **stdin**, never in argv. The working directory is an **empty temp directory**, so no project `CLAUDE.md`, `.mcp.json` or `.claude/` is discovered.

```ts
// argv (each element passed separately, no shell)
[
  'claude', '-p',
  '--output-format', 'json',
  '--model', model,                    // default 'haiku'
  '--effort', 'low',
  '--tools', '',                       // no built-in tools
  '--disallowedTools', 'mcp__*',       // --tools does not cover MCP tools
  '--strict-mcp-config',               // ignore every MCP config (none passed)
  '--setting-sources', '',             // ignore user/project/local settings (hooks, permissions)
  '--disable-slash-commands',          // no skills or commands
  '--no-session-persistence',          // nothing saved to ~/.claude/projects
  '--system-prompt', systemPrompt,     // replaces Claude Code's default prompt
  '--json-schema', JSON.stringify(schema),
  '--max-budget-usd', String(callCapUsd),
]
// stdin: the user prompt, with untrusted text inside a delimited data block
```

Observed with exactly these flags (run): the `system/init` event lists `tools: ["StructuredOutput"]`, `mcp_servers: []` and 0 slash commands, and the result has `structured_output: {"ok": true}`, `num_turns: 2` and `total_cost_usd: 0.00042`.

## Flags

| Flag | Status | What it does / what we saw |
|---|---|---|
| `-p`, `--print` | **run** | Non-interactive. Prints the result and exits. Skips the workspace trust dialog, so only run it in a directory we control (the empty temp dir). |
| prompt on stdin | **run** | `echo '…' \| claude -p …` works with no positional prompt. Docs: piped stdin is capped at **10 MB**; a larger input exits non-zero. |
| `--output-format json` | **run** | A single JSON object on stdout (fields below). `text` is the default. |
| `--output-format stream-json` | **run** | NDJSON events. With `-p` it **requires `--verbose`** (otherwise `Error: When using --print, --output-format=stream-json requires --verbose`). Only for debugging; the adapter uses `json`. |
| `--verbose` | **run** | Needed for `stream-json`. |
| `--json-schema '<schema>'` | **run** | Validated structured output, returned in `structured_output` (and as a JSON string in `result`). Internally it adds a `StructuredOutput` tool, so `num_turns` is 2 and `stop_reason` can be `tool_use`. Docs: an invalid schema exits with `Error: --json-schema is not a valid JSON Schema`; `format` is not enforced; **if the run ends without valid output, `structured_output` is absent**, so we check for it. We still zod-validate it. |
| `--model <alias\|id>` | **run** | `haiku` resolved to `claude-haiku-5-5` (from `modelUsage`). Full IDs also accepted (docs). An unknown model exits 1 with `is_error: true`, `api_error_status: 404`, but **`subtype: "success"`**, so check `is_error`, not `subtype`. |
| `--effort low` | **run** | Accepted with Haiku. Docs: `low`, `medium`, `high`, `xhigh`, `max`; the available levels depend on the model. |
| `--tools ""` | **run** | Removes all built-in tools. Docs: **it does not affect MCP tools**. |
| `--disallowedTools "mcp__*"` | **run** | Removes every MCP tool (docs: a bare name or glob removes matching tools from context). |
| `--strict-mcp-config` | **run** | Only MCP servers from `--mcp-config` (we pass none); `mcp_servers: []`. |
| `--setting-sources ""` | **run** | Accepted. Loads no user/project/local settings files, so no hooks or permission rules from Olaf's `~/.claude`. |
| `--disable-slash-commands` | **run** | 0 slash commands in `init`. |
| `--no-session-persistence` | **run** | Print mode only. The session isn't saved and can't be resumed. |
| `--system-prompt <text>` | **run** | Replaces the whole default prompt. `--system-prompt-file` exists too (docs). |
| `--max-budget-usd <n>` | **run** | Print mode only. **Checked after the spend, not before:** with `0.000001` the call still ran and cost $0.00034, then the run ended with `subtype: "error_max_budget_usd"`, `is_error: true`, exit 1. Docs: "Spend can pass the cap", and it uses a client-side estimate. **It is a safety net, not our budget control**: `providers/` must check the workspace budget *before* calling. |
| `--max-turns <n>` | **docs** | In the docs (print mode only) but **not in `claude --help` for 2.1.319**. Not used; the zero-tool setup bounds turns already. |
| `--bare` | **docs** | Skips hooks, plugins, MCP, CLAUDE.md and memory. **It never reads OAuth or the keychain**: it needs `ANTHROPIC_API_KEY` or `apiKeyHelper`. So it **can't be used on the Mac with Olaf's subscription login**, which is the point of the `claude-cli` adapter. On an API key, use the `anthropic-api` adapter instead. Docs say `--bare` will become the default for `-p` in a future release (see "Risks"). |
| `--permission-prompts none` | **docs** | Denies anything that would prompt. Redundant with zero tools; not used. |
| `--append-system-prompt` | **docs** | Not used (we replace the prompt entirely). |

## JSON result fields we read

From a real `--output-format json` run:

```json
{
  "type": "result",
  "subtype": "success",            // or "error_max_budget_usd", …
  "is_error": false,               // the field to branch on
  "result": "pong",                // text, or JSON string when --json-schema is set
  "structured_output": { … },      // only with --json-schema; absent when no valid output
  "total_cost_usd": 0.00061289,    // client-side estimate
  "usage": { "input_tokens": 2, "output_tokens": 4, "cache_creation_input_tokens": 3021, "cache_read_input_tokens": 649 },
  "modelUsage": { "claude-haiku-5-5": { "costUSD": 0.00061289, … } },
  "num_turns": 1,
  "api_error_status": null,        // e.g. 404 for an unknown model
  "terminal_reason": "completed",  // "budget_exhausted", "api_error", …
  "errors": ["…"],                 // present on some errors
  "session_id": "…"
}
```

Adapter rules:
1. Exit code 0 **and** `is_error === false` **and** `structured_output` present → zod-validate `structured_output`. Anything else is a failure, whatever `subtype` says.
2. Write `total_cost_usd` to `CostLedger` with provider `claude-cli`, marked as an estimate. On a subscription it's notional, but it keeps the ROI view honest.
3. Kill the process after a timeout (60 s default). Docs: SIGTERM exits with 143 and records no result.
4. Never pass untrusted text in argv; stdin only.

## Auth (rules from CLAUDE.md)

- We only ever run the official `claude` binary. We never read, copy or proxy `~/.claude` credentials or the keychain; the binary handles its own login.
- `claude auth status` reports login state as JSON (`loggedIn`, `authMethod`) without exposing tokens. A setup check may run it.
- The VPS and customers use the `anthropic-api` adapter with an API key, never the CLI.

## Risks to recheck on CLI upgrades

- `--bare` becoming the `-p` default would make the CLI ignore the subscription login. The adapter should fail clearly ("not logged in / needs API key"). On every CLI upgrade, rerun the canonical invocation above and update this file (`pnpm --filter @le/engine check:claude` runs it with a one-line prompt).
- `--max-turns` is in the docs but not in `--help`. Don't rely on it.
- Model aliases move: `haiku` resolved to `claude-haiku-5-5` today. Record `modelUsage` keys in the ledger.
