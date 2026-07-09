# @trovyhq/mcp-server

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for Trovy. Lets any MCP-aware client (Claude Desktop, Cursor, Cline, Continue, …) read and write your Trovy data through natural conversation.

## What you can do once it's connected

> "Move TF-12 to in review and add a comment saying ready for QA"
>
> "Create a task in TF called 'Investigate webhook timeout' with priority high"
>
> "What did I ship last week?"

Under the hood the server exposes 8 tools (`list_projects`, `search_tasks`, `list_tasks`, `get_task`, `create_task`, `update_task_status`, `add_comment`, `link_pr`).

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
        "TROVY_API_URL": "https://api.trovy.app",
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
Env: TROVY_API_URL=https://api.trovy.app;TROVY_TOKEN=tfp_your-token
```

#### Cline / Continue / others

Same shape — they all use `command` + `args` + `env` for stdio MCP servers.

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
