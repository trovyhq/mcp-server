#!/usr/bin/env node
/**
 * @taskflowapp/mcp-server — MCP (Model Context Protocol) server for TaskFlow.
 *
 * Exposes TaskFlow as a set of tools that any MCP-aware client (Claude
 * Desktop, Cursor, Continue, Cline, etc.) can call. Running, e.g.:
 *
 *     npx -y @taskflowapp/mcp-server
 *
 * reads the token from the `TASKFLOW_TOKEN` env var (and `TASKFLOW_API_URL`,
 * defaulting to `http://localhost:3000`) and serves tools over stdio.
 *
 * Tools exposed (8, all bounded by the user's account permissions):
 *
 *   list_projects
 *   search_tasks
 *   list_tasks
 *   get_task
 *   create_task
 *   update_task_status
 *   add_comment
 *   link_pr
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { TaskFlowClient, TaskFlowError, parseTaskRef } from '@taskflowapp/sdk';

// ── Bootstrap ─────────────────────────────────────────────────────────────

const apiUrl = process.env.TASKFLOW_API_URL ?? 'http://localhost:3000';
const token = process.env.TASKFLOW_TOKEN;

if (!token) {
  process.stderr.write(
    'taskflow-mcp: TASKFLOW_TOKEN env var is required.\n' +
      'Generate one at /settings/api-tokens in the TaskFlow web UI.\n'
  );
  process.exit(1);
}

const tf = new TaskFlowClient({ apiUrl, token });

const server = new Server(
  {
    name: 'taskflow',
    version: '0.1.0',
  },
  {
    capabilities: { tools: {} },
  }
);

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_projects',
    description:
      'List every project the current user owns or is a member of. Returns the project key (e.g. "TF") — needed to reference tasks as TF-12.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_tasks',
    description:
      'Full-text search across projects, tasks, and users. Returns matching projects (with their key), tasks (with number), and users.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query (min 2 chars).' },
        limit: { type: 'number', description: 'Max results per category. Default 10.' },
      },
      required: ['q'],
    },
  },
  {
    name: 'list_tasks',
    description:
      'List tasks in a single project. Either the project id or its key (e.g. "TF") works. For tasks across ALL projects assigned to the current user, use `list_my_tasks` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        project_key_or_id: { type: 'string', description: 'Project key (e.g. "TF") or id.' },
        status: {
          type: 'string',
          enum: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED'],
        },
        assignee_me: {
          type: 'boolean',
          description: 'If true, only tasks assigned to the current user. Default false.',
        },
        limit: { type: 'number', description: 'Max tasks to return. Default 50.' },
      },
      required: ['project_key_or_id'],
    },
  },
  {
    name: 'list_my_tasks',
    description:
      'List every task assigned to the current user across ALL their projects. The right tool when the user says "show my tasks", "what am I working on", "my open tickets". Optional status filter. Returns up to 100 tasks ordered by priority, then due date.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED'],
          description: 'Optional. If set, only return tasks in that status.',
        },
        limit: { type: 'number', description: 'Max tasks to return. Default 50, max 100.' },
      },
    },
  },
  {
    name: 'get_task',
    description:
      'Get full task detail by id or by short reference (TF-12). Returns description, comments, assignees, labels, GitHub links.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: {
          type: 'string',
          description: 'Either a task id or a short reference like "TF-12".',
        },
      },
      required: ['task_ref'],
    },
  },
  {
    name: 'create_task',
    description:
      'Create a new task in a project. Requires the project key (e.g. "TF") or its id.',
    inputSchema: {
      type: 'object',
      properties: {
        project_key_or_id: { type: 'string', description: 'Project key (e.g. "TF") or id.' },
        title: { type: 'string', description: 'Task title.' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
        type: {
          type: 'string',
          enum: ['TASK', 'BUG', 'FEATURE', 'IMPROVEMENT', 'EPIC', 'STORY'],
        },
        assignee_usernames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Usernames to assign. Resolved to user ids via /api/users/search.',
        },
      },
      required: ['project_key_or_id', 'title'],
    },
  },
  {
    name: 'update_task_status',
    description:
      'Move a task to a new status. Accepts either the task id or a short reference (TF-12).',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
        status: {
          type: 'string',
          enum: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED'],
        },
      },
      required: ['task_ref', 'status'],
    },
  },
  {
    name: 'add_comment',
    description:
      'Post a comment on a task. @mentions via @username fire notifications and emails.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
        content: { type: 'string', description: 'Comment text. @username syntax works.' },
      },
      required: ['task_ref', 'content'],
    },
  },
  {
    name: 'link_pr',
    description:
      'Attach a GitHub PR URL to a task. The task will auto-close when the PR is merged (requires the GitHub webhook to be configured).',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
        pr_url: { type: 'string', description: 'Full GitHub PR URL.' },
      },
      required: ['task_ref', 'pr_url'],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ── Tool implementations ──────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;

  try {
    switch (name) {
      case 'list_projects': {
        const r = await tf.listProjects();
        return ok(r.projects.map(formatProject));
      }

      case 'search_tasks': {
        const q = String(a.q ?? '');
        const limit = Number(a.limit ?? 10);
        if (q.length < 2) throw new McpError(ErrorCode.InvalidParams, 'q must be at least 2 chars');
        const r = await tf.search(q, limit);
        return ok({
          projects: r.projects.map(formatProject),
          tasks: r.tasks.map(formatTask),
          users: r.users,
        });
      }

      case 'list_tasks': {
        const { id: projectId } = await tf.resolveProjectKeyAndId(String(a.project_key_or_id));
        const status = a.status as any;
        const assigneeMe = Boolean(a.assignee_me);
        const limit = Number(a.limit ?? 50);

        const r = await tf.listTasks(projectId, {
          status,
          assigneeId: assigneeMe ? 'me' : undefined,
          limit,
        });
        return ok(r.tasks.map(formatTask));
      }

      case 'list_my_tasks': {
        const status = a.status as any;
        const limit = Math.min(Number(a.limit ?? 50), 100);
        const r = await tf.listMyAssignedTasks({
          status,
          limit,
        });
        return ok({
          count: r.tasks.length,
          tasks: r.tasks.map(formatTask),
        });
      }

      case 'get_task': {
        const { task } = await resolveTask(String(a.task_ref));
        return ok(formatTask(task));
      }

      case 'create_task': {
        const { id: projectId } = await tf.resolveProjectKeyAndId(String(a.project_key_or_id));
        // Resolve assignee usernames → ids (best effort).
        let assigneeIds: string[] | undefined;
        const usernames: string[] | undefined = a.assignee_usernames;
        if (Array.isArray(usernames) && usernames.length) {
          const found = await Promise.all(
            usernames.map(async (u) => {
              const r = await tf.search(u, 5);
              return r.users.find((x) => x.username?.toLowerCase() === u.toLowerCase())?.id;
            })
          );
          assigneeIds = found.filter((x): x is string => Boolean(x));
        }

        const { task } = await tf.createTask({
          projectId,
          title: String(a.title),
          description: a.description ? String(a.description) : undefined,
          priority: a.priority as any,
          type: a.type as any,
          assigneeIds,
        });
        return ok(formatTask(task));
      }

      case 'update_task_status': {
        const { taskId } = await resolveTask(String(a.task_ref));
        const status = String(a.status) as any;
        const { task } = await tf.moveTask(taskId, status);
        return ok(formatTask(task));
      }

      case 'add_comment': {
        const { taskId } = await resolveTask(String(a.task_ref));
        const content = String(a.content ?? '').trim();
        if (!content) throw new McpError(ErrorCode.InvalidParams, 'content is required');
        const { comment } = await tf.addComment(taskId, content);
        return ok({
          id: comment.id,
          taskId,
          content: comment.content,
          author: comment.author.name ?? comment.author.username ?? comment.author.email,
          createdAt: comment.createdAt,
        });
      }

      case 'link_pr': {
        const { taskId } = await resolveTask(String(a.task_ref));
        const prUrl = String(a.pr_url ?? '').trim();
        if (!/^https?:\/\/(www\.)?github\.com\//.test(prUrl)) {
          throw new McpError(ErrorCode.InvalidParams, 'pr_url must be a GitHub URL');
        }
        const r = await tf.linkPr(taskId, prUrl);
        return ok({ taskId, prUrl, task: formatTask(r.task as any) });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (e: any) {
    if (e instanceof McpError) throw e;
    if (e instanceof TaskFlowError) {
      throw new McpError(
        e.status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest,
        `TaskFlow API ${e.status}: ${e.message}`,
        e.body as any
      );
    }
    throw new McpError(ErrorCode.InternalError, e?.message ?? 'Internal error');
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function resolveTask(ref: string) {
  // If it's a cuid, fetch directly. Otherwise resolve via short reference.
  const parsed = parseTaskRef(ref);
  if (parsed) {
    return tf.resolveTaskRef(ref);
  }
  const r = await tf.getTask(ref);
  return {
    projectKey: r.task.project.key,
    projectId: r.task.project.id,
    taskId: r.task.id,
    task: r.task,
  };
}

function formatProject(p: {
  id: string;
  key: string;
  name: string;
  color: string;
  description?: string | null;
  visibility: string;
}) {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    color: p.color,
    description: p.description,
    visibility: p.visibility,
    ref: `[${p.key}]`,
  };
}

function formatTask(t: any) {
  return {
    id: t.id,
    ref: `[${t.project.key}-${t.number}]`,
    key: t.project.key,
    number: t.number,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    type: t.type,
    storyPoints: t.storyPoints,
    estimateMinutes: t.estimateMinutes,
    dueDate: t.dueDate,
    completedAt: t.completedAt,
    assignees: (t.assignees ?? []).map((a: any) => ({
      username: a.user.username,
      name: a.user.name,
      email: a.user.email,
    })),
    labels: (t.labels ?? []).map((l: any) => l.label.name),
    githubIssueNumber: t.githubIssueNumber,
    githubIssueUrl: t.githubIssueUrl,
    githubPrUrl: t.githubPrUrl,
    url: `${apiUrl.replace(/\/api$/, '')}/projects/${t.projectId}/tasks/${t.id}`,
  };
}

function ok(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

// ── Start ─────────────────────────────────────────────────────────────────

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr — stdout is the MCP channel and must stay untouched.
  process.stderr.write(`taskflow-mcp ready — api=${apiUrl}\n`);
})().catch((e) => {
  process.stderr.write(`taskflow-mcp fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});
