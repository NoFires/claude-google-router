# claude-google-router (`cgr`)

Standalone multi-provider routing gateway, `.cmd`/`.ps1` launcher, and surgical `~/.claude/settings.json` provider manager for **Claude Code**.

Route Claude Code to **Google Vertex AI / Gemini** (`gemini-4-hydrogen`, `gemini-4-argon`, `gemini-4-carbon`) alongside **Zhipu BigModel**, **DeepSeek**, or any Anthropic/OpenAI-compatible upstream — with built-in model modality awareness, Claude Code `/model` picker injection (`modelPicker.options`), and automatic exit-restore policies.

## Features

- **Zero runtime dependencies** (pure Node.js >= 20 built-ins).
- **Unified Multi-Provider Dispatch & Display Selection**:
  - All enabled providers (`google`, `bigmodel`, `deepseek`, `openai`, etc.) are always routed through one unified gateway (`127.0.0.1:18765`) — **no preset switching required**.
  - `cgr expose <all|id1,id2,...>` (or Web UI checkboxes / TUI `[3]`) lets you choose **which subset of saved models** is displayed in Claude Code `/model` (`modelPicker.options`) and `/v1/models`, while all enabled models remain callable anytime.
- **Standalone Launcher (`cgr.cmd`, `cgr.ps1`, and global `cgr` CLI)**:
  - `cgr` (no args in TTY): opens interactive terminal manager (start/stop daemon, toggle which models are shown in Claude `/model`, set default model, inspect model modalities, import profiles, switch direct profile, configure exit policy, launch Claude Code).
  - `cgr start --daemon` / `cgr stop`: background gateway lifecycle with persistent `exitRestore` policy (`backup`, `profile`, `none`).
  - `cgr expose <all | id1,id2,...>`: pick which saved models appear in Claude Code `/model` & `/v1/models`.
  - `cgr use <provider/model>`: set the initial default model and sync `~/.claude/settings.json`.
  - `cgr direct <profileId>`: bypass the gateway and switch `~/.claude/settings.json` directly to an imported external profile.
  - `cgr run [--model <provider/model>] [-- <claude-args>...]`: launch Claude Code in an isolated temporary `--settings` file.
- **Surgical `~/.claude/settings.json` Management**:
  - Only manages provider-related `env` keys (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_SUBAGENT_MODEL`), `model`, and `modelPicker`.
  - Never overwrites `hooks`, `enabledPlugins`, `permissions`, or custom `env` variables.
  - Injects `modelPicker.options` (`behavesAs`, `replaceBuiltInOptions: true` by default) and serves `GET /v1/models` with your selected models.
- **Model Modality & Polymorphism Distinction**:
  - Models can be strings (`"gemini-4-hydrogen[1m]"`) or polymorphic objects (`{ id, visible, modalities, thinking, tools, contextWindow, behavesAs }`).
  - Distinguishes `text+image` (multimodal) vs `text`-only models and `thinking` vs non-thinking models.
  - Supports `routes.visionFallbackTarget` to automatically reroute multimodal image requests when the selected model is text-only, or gracefully degrades image blocks / strips unsupported thinking config.
- **Web Dashboard (`http://127.0.0.1:18765/`)**:
  - Unified model pool with per-model display checkboxes (`Show in /model`), one-click `Set Default` & `Test`, direct external profile switcher, persistent exit-restore selector, provider/route editors, and live request monitor.

## Quick Start

```powershell
# 1. Import existing providers & profiles from ~/.claude/settings.json*
cgr import-claude

# 2. Configure Google Express API Key + Project (optional if already saved or in env)
cgr init --api-key "AQ.YOUR_KEY" --project "YOUR_GCP_PROJECT_ID" --location global

# 3. Inspect all saved models, visibility ([x]/[ ]), and modalities
cgr models

# 4. Choose which models to display in Claude Code /model (e.g. pick 3 across Google & BigModel)
cgr expose google/gemini-4-hydrogen[1m],google/gemini-4-carbon[1m],bigmodel/glm-5.3[1M]

# 5. Start background gateway (auto-syncs ~/.claude/settings.json + modelPicker)
cgr start --daemon

# 6. Set default model or exit-restore policy anytime
cgr use google/gemini-4-hydrogen[1m]
cgr exit-policy backup
cgr stop

# Or open the interactive menu anytime:
cgr
```

## Model Routing Priority

1. Explicit `provider/model` prefix (e.g. `google/gemini-4-hydrogen[1m]`, `bigmodel/glm-5.3[1M]`, `deepseek/deepseek-flash[1m]`).
2. Optional `routes.visionFallbackTarget` when the request contains image blocks and the selected model is `text`-only.
3. Wildcard rules (`routes.rules`, e.g. `gemini-* -> google/$0`, `glm-* -> bigmodel/$0`, `deepseek-* -> deepseek/$0`).
4. Claude family / slot targets: `opus`, `sonnet`, `haiku`, `fable`.
5. Declared provider `models[]` list match.
6. `routes.defaultTarget`.

## Install with an AI Agent (Claude Code / Cursor / Codex)

You can let an AI coding agent install, link, and configure `claude-google-router` for you automatically.

### Option A: Copy-Paste Prompt for Your Agent

Paste this into Claude Code, Cursor, or any terminal-capable AI agent:

```text
Clone or open claude-google-router, verify Node.js >= 20, run `npm test` to confirm all tests pass, and install the CLI globally via `npm link` (or add the repo path to PATH on Windows for `cgr.cmd` / `cgr.ps1`).
Then run `cgr import-claude` to import my existing ~/.claude/settings.json profiles without overwriting my hooks/plugins, and ask me for my Google Vertex / Gemini API key (never hardcode keys into the repo).
Finally, run `cgr start --daemon` and `cgr status` to verify the gateway is listening on 127.0.0.1:18765.
```

### Option B: Standard Agent Setup Steps

If you are authoring an agent skill or setup script, execute these steps in order:

```bash
# 1. Clone and verify runtime (Node.js >= 20, zero npm dependencies)
git clone <YOUR_REPO_URL> claude-google-router
cd claude-google-router
npm test

# 2. Install global `cgr` command
npm link

# 3. Import existing Claude Code profiles (non-destructive, backs up settings)
cgr import-claude

# 4. Initialize Google Vertex / Gemini credentials (stored in ~/.claude-google-router/config.json)
cgr init --api-key "$GOOGLE_CLOUD_API_KEY" --project "$GOOGLE_CLOUD_PROJECT" --location global

# 5. Start background daemon and verify
cgr start --daemon
cgr status
```

> **Privacy Note:** All API keys, service account paths, and imported Claude profiles are stored locally in `~/.claude-google-router/config.json`, never inside this repository.

## Project Modules

- `lib/router.js`: Core HTTP gateway (`ClaudeGoogleRouterServer`), multi-account pool/failover, and `/v1/messages` dispatch.
- `lib/admin-api.js`: Local management endpoints (`/api/*`, `/health`) and secret redaction.
- `lib/dashboard.js`: Embedded Web Dashboard UI (`http://127.0.0.1:18765/`).
- `lib/translator.js` / `lib/schema.js` / `lib/signatures.js`: Anthropic <-> Gemini translation, schema sanitization, and thought signature store.
- `lib/anthropic-upstream.js` / `lib/openai-upstream.js`: Anthropic-compatible and OpenAI-compatible upstream dispatchers.
- `lib/routing-table.js`: Model route resolution (prefixes, wildcards, slots, vision/recap fallbacks).
- `lib/config.js` / `lib/model-catalog.js` / `lib/claude-import.js` / `lib/auth.js`: Config normalization, model catalog/visibility, Claude profile import, and Google auth.
- `lib/claude-settings.js`: Surgical `~/.claude/settings.json` sync and exit-restore policies.
- `lib/cli.js` / `lib/cli-commands.js` / `lib/daemon.js` / `lib/manager-tui.js`: CLI entry, subcommands, background daemon lifecycle, and interactive terminal manager.

