# @trovyhq/mcp-server

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for Trovy. Lets any MCP-aware client (Claude Desktop, Cursor, Cline, Continue, …) read and write your Trovy data through natural conversation.

## What you can do once it's connected

> "Move TF-12 to in review and add a comment saying ready for QA"
>
> "Create a task in TF called 'Investigate webhook timeout' with priority high"
>
> "What did I ship last week?"

Under the hood the server exposes 20 tools for projects, tasks, dependencies, recurrence, time tracking, users, and notifications.

## Setup

### 1. Create a token

In Trovy: **Settings → Intégrations → Jetons d'API → Nouveau token**.

Copy the plaintext token (you'll only see it once). Recommended: a long-lived token with no expiration.

### 2. Configure your MCP client

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "trovy": {
      "command": "npx",
      "args": ["-y", "@trovyhq/mcp-server"],
      "env": {
        "TROVY_API_URL": "https://trovy.app",
        "TROVY_TOKEN": "tfp_your-token-here"
      }
    }
  }
}
```

Restart Claude Desktop. You should see a 🔧 icon listing 8 Trovy tools.

#### Cursor

`Settings → Features → Model Context Protocol → Add server`:

```
Name: trovy
Command: npx -y @trovyhq/mcp-server
Env: TROVY_API_URL=https://trovy.app;TROVY_TOKEN=tfp_your-token
```

#### Cline / Continue / others

Same shape — they all use `command` + `args` + `env` for stdio MCP servers.

### Codex plugin

The repository includes a public Codex marketplace and the `trovy` plugin. Add the marketplace and install the plugin:

```bash
codex plugin marketplace add trovyhq/mcp-server
codex plugin add trovy@trovy-public
```

Set your token in the environment before starting Codex:

```bash
export TROVY_TOKEN=tfp_your-token-here
```

Restart Codex or the ChatGPT desktop app, then start a new task. The plugin forwards `TROVY_TOKEN` to the bundled MCP server and uses `https://trovy.app` by default.

### ChatGPT web

The npm package uses the local `stdio` transport. ChatGPT web requires a deployed Streamable HTTP MCP server published through the OpenAI plugin submission portal. The bundled Codex plugin is ready for local testing and GitHub distribution; public ChatGPT web distribution additionally requires the hosted transport, user authentication, privacy policy, terms, and OpenAI review.

## Local development

```bash
# From the repo root
pnpm install
pnpm --filter @trovyhq/mcp-server build

# Run with explicit token
TROVY_API_URL=http://localhost:3000 TROVY_TOKEN=tfp_xxx node integrations/mcp-server/dist/index.js
```

## License

MIT
