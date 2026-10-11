# Omnirush2API

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8.2-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/docs/api-reference)

> **High-performance, dual-runtime OpenAI-compatible API reverse router & OAuth tunnel for [Omnirush.ai](https://omnirush.ai)**  
> Bridge Omnirush OAuth refresh tokens into a universal OpenAI-compatible endpoint to unlock **GPT-6 Astra, GPT-6.1 Sol, and GPT-6 Sol** models across **Claude Code, Cursor, Codex, OpenCode, Antigravity, Aider, 9Router, and LibreChat**.

---

## Features

- **Zero Runtime Dependencies**: Built entirely with native Node.js (`node:http`, `node:fs`) and standard Web APIs (`fetch`, Web Streams). No bloated HTTP frameworks.
- **Dual-Runtime Execution**: Run locally as a lightweight daemon or deploy 24/7 serverless on **Cloudflare Workers**.
- **Interactive Terminal Device Flow (`omnirush2api login`)**: Log into Omnirush directly from your terminal using the OAuth device code flow.
- **Automatic Desktop Credential Discovery**: Automatically finds local credentials stored by Omnirush Desktop across Windows (`%APPDATA%\OmniRush`), macOS, and Linux.
- **Multi-Account Round-Robin Pool**: Support multiple refresh tokens with automatic account rotation and quota exhaustion backoff (`HTTP 429` / `Retry-After`).
- **Full SSE Streaming & Reasoning Support**: Preserves native reasoning deltas (`delta.reasoning_content`) for deep thinking workflows in Claude Code, Cursor, and OpenCode.
- **Model Aliasing**: Call models using simple aliases like `astra`, `gpt-6`, `omnirush`, or `sol`.

---

## Quick Start

### Method 1: Local Daemon

#### Step 1: Install & Build
Clone the repository and install dev dependencies:
```bash
git clone https://github.com/IMROVOID/Omnirush2API.git
cd Omnirush2API
npm install
npm run build
```

#### Step 2: Authenticate
Log in directly using the terminal OAuth flow:
```bash
node dist/cli.js login
```
Or verify existing desktop credentials:
```bash
node dist/cli.js check
```

#### Step 3: Start the Router
Run the local daemon (default port: `20129`):
```bash
node dist/cli.js start
```

Or specify a custom port and optional Bearer API key:
```bash
node dist/cli.js start --port 20129 --key sk-my-secret-key
```

Your OpenAI-compatible endpoint is now ready at:
```
http://localhost:20129/v1
```

---

### Method 2: Cloudflare Workers (24/7 Serverless)

Deploy a free, 24/7 serverless gateway without keeping your local computer running:

1. Open [`worker/worker.js`](./worker/worker.js) and copy the entire file contents.
2. In the [Cloudflare Dashboard](https://dash.cloudflare.com), go to **Workers & Pages** -> **Create application** -> **Create Worker**.
3. Name it `omnirush2api` and click **Deploy**.
4. Click **Edit code**, delete existing placeholder code, paste the contents of `worker/worker.js`, and click **Deploy**.
5. In **Settings** -> **Variables and Secrets**, add:
   - `OMNIRUSH_REFRESH_TOKEN` (Secret): Your Omnirush refresh token (supports multi-line tokens for pooling).
   - `API_KEY` (Secret, Optional): Your custom bearer key to protect the endpoint.
6. Your serverless API is available at:
   ```
   https://omnirush2api.<your-subdomain>.workers.dev/v1
   ```

---

## Model Catalog & Aliases

| Model Alias | Upstream Model ID | Context Limit | Max Output | Description |
|---|---|---|---|---|
| `gpt-6-astra`, `astra`, `gpt-6`, `omnirush` | `gpt-6-astra` | 200,000 | 16,384 | Flagship deep reasoning model |
| `gpt-6.1-sol`, `sol-pro` | `gpt-6.1-sol` | 200,000 | 16,384 | Frontier reasoning & coding model |
| `gpt-6-sol`, `sol` | `gpt-6-sol` | 128,000 | 8,192 | Low-latency high-speed model |

---

## Client Integration Examples

### Claude Code
```bash
export ANTHROPIC_BASE_URL="http://localhost:20129/v1"
export ANTHROPIC_API_KEY="sk-omnirush"
export ANTHROPIC_MODEL="gpt-6-astra"
claude
```

### Cursor / Windsurf
- **OpenAI Base URL**: `http://localhost:20129/v1`
- **API Key**: `sk-omnirush` (or any string)
- **Model Names**: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`

### 9Router (`~/.9router/db.json`)
```json
{
  "providers": [
    {
      "id": "omnirush2api",
      "name": "Omnirush2API",
      "type": "openai",
      "baseUrl": "http://localhost:20129/v1",
      "apiKey": "sk-omnirush",
      "models": [
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6-sol"
      ]
    }
  ]
}
```

---

## CLI Reference

```text
Usage:
  omnirush2api <command> [options]

Commands:
  start               Start the local OpenAI-compatible API daemon (default)
  login               Initiate interactive terminal OAuth device flow
  check               Inspect and verify local credentials & quota status
  tokens              Manage stored refresh tokens (list, add, remove)

Options:
  -p, --port <number> Specify port for the HTTP daemon (default: 20129)
  -h, --host <host>   Specify host address (default: 127.0.0.1)
  -k, --key <string>  Set required Bearer API key for incoming requests
  --gateway-url <url> Override upstream OmniRush gateway URL
  --token <tokens>    Specify one or more refresh tokens (comma-separated)
  -v, --version       Display version information
  --help              Display this help message
```

---

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE) for details.
