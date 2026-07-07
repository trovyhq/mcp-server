# @taskflow/mcp-server

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for TaskFlow. Lets any MCP-aware client (Claude Desktop, Cursor, Cline, Continue, …) read and write your TaskFlow data through natural conversation.

## What you can do once it's connected

> "Move TF-12 to in review and add a comment saying ready for QA"
>
> "Create a task in TF called 'Investigate webhook timeout' with priority high"
>
> "What did I ship last week?"

Under the hood the server exposes 8 tools (`list_projects`, `search_tasks`, `list_tasks`, `get_task`, `create_task`, `update_task_status`, `add_comment`, `link_pr`).

## Setup

### 1. Create a token

In TaskFlow: **Settings → Intégrations → Jetons d'API → Nouveau token**.

Copy the plaintext token (you'll only see it once). Recommended: a long-lived token with no expiration.

### 2. Configure your MCP client

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "npx",
      "args": ["-y", "@taskflow/mcp-server"],
      "env": {
        "TASKFLOW_API_URL": "https://api.taskflow.app",
        "TASKFLOW_TOKEN": "tfp_your-token-here"
      }
    }
  }
}
```

Restart Claude Desktop. You should see a 🔧 icon listing 8 TaskFlow tools.

#### Cursor

`Settings → Features → Model Context Protocol → Add server`:

```
Name: taskflow
Command: npx -y @taskflow/mcp-server
Env: TASKFLOW_API_URL=https://api.taskflow.app;TASKFLOW_TOKEN=tfp_your-token
```

#### Cline / Continue / others

Same shape — they all use `command` + `args` + `env` for stdio MCP servers.

## Local development

```bash
# From the repo root
pnpm install
pnpm --filter @taskflow/mcp-server build

# Run with explicit token
TASKFLOW_API_URL=http://localhost:3000 TASKFLOW_TOKEN=tfp_xxx node integrations/mcp-server/dist/index.js
```

## License

MIT
