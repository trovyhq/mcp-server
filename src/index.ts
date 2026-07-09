#!/usr/bin/env node
/**
 * @trovyhq/mcp-server — MCP (Model Context Protocol) server for Trovy.
 *
 * Exposes Trovy as a set of tools that any MCP-aware client (Claude
 * Desktop, Cursor, Continue, Cline, Codex, etc.) can call. Running, e.g.:
 *
 *     npx -y @trovyhq/mcp-server
 *
 * reads the token from the `TROVY_TOKEN` env var (and `TROVY_API_URL`,
 * defaulting to `http://localhost:3000`) and serves tools over stdio.
 *
 * Tools exposed (19 in v0.2.0, all bounded by the user's account permissions):
 *
 *   Projects:
 *     list_projects
 *
 *   Tasks — read:
 *     search_tasks          search across projects/tasks/users
 *     list_tasks            list tasks of one project (by key or id)
 *     list_my_tasks         list every task assigned to me across projects
 *     get_smart_inbox       5 grouped sections (review, mentions, active, recent, stale)
 *     get_task              full detail of one task (comments, attachments, etc.)
 *     list_dependencies     what blocks this task / what this task blocks
 *
 *   Tasks — write:
 *     create_task
 *     update_task_status
 *     add_comment
 *     link_pr               attach a GitHub PR URL
 *     share_task            create a public share link
 *     bulk_update           apply status/priority/delete to many tasks
 *
 *   Recurrence:
 *     set_recurrence
 *     clear_recurrence
 *
 *   Dependencies:
 *     add_dependency
 *     remove_dependency
 *
 *   Time tracking:
 *     log_time
 *
 *   Users:
 *     search_users          for @mention / assignment resolution
 *     list_notifications    recent in-app notifications
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { TrovyClient, TrovyError, parseTaskRef } from '@trovyhq/sdk';

// ── Bootstrap ─────────────────────────────────────────────────────────────

const apiUrl = process.env.TROVY_API_URL ?? 'http://localhost:3000';
const token = process.env.TROVY_TOKEN;

if (!token) {
  process.stderr.write(
    'trovy-mcp: TROVY_TOKEN env var is required.\n' +
      'Generate one at /settings/api-tokens in the Trovy web UI.\n'
  );
  process.exit(1);
}

const tf = new TrovyClient({ apiUrl, token });

const server = new Server(
  {
    name: 'trovy',
    version: '0.2.0',
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
    name: 'search_users',
    description:
      'Look up users by username, name, or email. Used to resolve mentions / assignees to user ids.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query.' },
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
        search: { type: 'string', description: 'Free-text search on title/description.' },
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
    name: 'get_smart_inbox',
    description:
      'Fetch the smart grouped inbox — 5 sections: tasks awaiting my review, mentions, my active tasks, recently done by me, and stale tasks (no activity in 14+ days). Use scope="mine" to restrict to projects I own or am a member of.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'mine'],
          description: 'all = every project visible to me. mine = projects where I am owner/member.',
        },
      },
    },
  },
  {
    name: 'get_task',
    description:
      'Get full task detail by id or by short reference (TF-12). Returns description, comments, assignees, labels, GitHub links, time entries, attachments, checklists.',
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
    name: 'list_dependencies',
    description:
      'For a given task, list tasks that block it (blockedBy) and tasks that it blocks (blocks). Returns the related tasks with their project key, number and status.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
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
        due_date: { type: 'string', description: 'ISO datetime for due date.' },
        estimate_minutes: { type: 'number' },
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
  {
    name: 'share_task',
    description:
      'Create (or refresh) a public share link for a task. Returns the share URL. Token expires after 30 days.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
      },
      required: ['task_ref'],
    },
  },
  {
    name: 'bulk_update',
    description:
      'Apply an action to many tasks at once. action="setStatus" requires payload.status, action="setPriority" requires payload.priority, action="delete" needs no payload. Max 200 tasks per call.',
    inputSchema: {
      type: 'object',
      properties: {
        task_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids or short references like "TF-12". Max 200.',
        },
        action: {
          type: 'string',
          enum: ['setStatus', 'setPriority', 'delete'],
        },
        status: {
          type: 'string',
          enum: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED'],
          description: 'For action=setStatus.',
        },
        priority: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
          description: 'For action=setPriority.',
        },
      },
      required: ['task_refs', 'action'],
    },
  },
  {
    name: 'set_recurrence',
    description:
      'Set or replace a task recurrence rule. frequency=DAILY|WEEKLY|MONTHLY. For WEEKLY, by_day is an array of weekday numbers (0=Sun..6=Sat). For MONTHLY, by_day is the day-of-month. hour is UTC hour-of-day for the spawn (default 9).',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
        frequency: {
          type: 'string',
          enum: ['DAILY', 'WEEKLY', 'MONTHLY'],
        },
        by_day: {
          type: 'array',
          items: { type: 'number' },
          description: 'WEEKLY: 0..6 (Sun..Sat). MONTHLY: 1..31.',
        },
        hour: {
          type: 'number',
          description: 'UTC hour-of-day for spawn (0..23). Default 9.',
        },
        ends_at: {
          type: 'string',
          description: 'Optional ISO datetime — spawns stop once now > endsAt.',
        },
      },
      required: ['task_ref', 'frequency'],
    },
  },
  {
    name: 'clear_recurrence',
    description: 'Remove any existing recurrence rule on a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
      },
      required: ['task_ref'],
    },
  },
  {
    name: 'add_dependency',
    description:
      'Mark a task as blocked by another task. Both must be in the same project. Throws 400 on cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'The task to mark as blocked.' },
        depends_on_ref: {
          type: 'string',
          description: 'The blocker (must be in the same project).',
        },
      },
      required: ['task_ref', 'depends_on_ref'],
    },
  },
  {
    name: 'remove_dependency',
    description: 'Remove a blocker relationship between two tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'The previously-blocked task.' },
        depends_on_ref: { type: 'string', description: 'The blocker to remove.' },
      },
      required: ['task_ref', 'depends_on_ref'],
    },
  },
  {
    name: 'log_time',
    description: 'Log time (in minutes) against a task. Optional description + when.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ref: { type: 'string', description: 'Task id or short reference like TF-12.' },
        minutes: { type: 'number', description: 'Minutes to log (positive integer).' },
        description: { type: 'string', description: 'What did you work on?' },
        started_at: { type: 'string', description: 'ISO datetime. Default: now.' },
      },
      required: ['task_ref', 'minutes'],
    },
  },
  {
    name: 'list_notifications',
    description:
      'List recent in-app notifications for the current user, plus the unread count.',
    inputSchema: {
      type: 'object',
      properties: {
        read_all: {
          type: 'boolean',
          description: 'If true, mark every unread notification as read and return ok.',
        },
      },
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
      // ── Read ────────────────────────────────────────────────────────────

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

      case 'search_users': {
        const q = String(a.q ?? '');
        if (q.length < 1) throw new McpError(ErrorCode.InvalidParams, 'q is required');
        const r = await tf.searchUsers(q);
        return ok({ users: r.users });
      }

      case 'list_tasks': {
        const { id: projectId } = await tf.resolveProjectKeyAndId(String(a.project_key_or_id));
        const status = a.status as any;
        const assigneeMe = Boolean(a.assignee_me);
        const limit = Number(a.limit ?? 50);
        const search = a.search ? String(a.search) : undefined;

        const r = await tf.listTasks(projectId, {
          status,
          assigneeId: assigneeMe ? 'me' : undefined,
          search,
          limit,
        });
        return ok({ count: r.tasks.length, tasks: r.tasks.map(formatTask) });
      }

      case 'list_my_tasks': {
        const status = a.status as any;
        const limit = Math.min(Number(a.limit ?? 50), 100);
        const r = await tf.listMyAssignedTasks({ status, limit });
        return ok({ count: r.tasks.length, tasks: r.tasks.map(formatTask) });
      }

      case 'get_smart_inbox': {
        const scope = (a.scope === 'mine' ? 'mine' : 'all') as 'all' | 'mine';
        const inbox = await tf.smartInbox(scope);
        return ok({
          scope: inbox.scope,
          counts: inbox.counts,
          awaitingReview: inbox.groups.awaitingReview.map(formatTask),
          mentioned: inbox.groups.mentioned.map((m) => ({
            task: formatTask(m.task),
            notification: m.notification,
          })),
          assignedActive: inbox.groups.assignedActive.map(formatTask),
          recentlyDone: inbox.groups.recentlyDone.map(formatTask),
          stale: inbox.groups.stale.map(formatTask),
        });
      }

      case 'get_task': {
        const { task } = await resolveTask(String(a.task_ref));
        return ok(formatTaskFull(task));
      }

      case 'list_dependencies': {
        const { taskId } = await resolveTask(String(a.task_ref));
        const r = await tf.listDependencies(taskId);
        return ok({
          blockedBy: r.blockedBy.map((d) => ({
            dependencyId: d.id,
            task: d.dependsOn ? formatRelated(d.dependsOn) : null,
          })),
          blocks: r.blocks.map((d) => ({
            dependencyId: d.id,
            task: d.task ? formatRelated(d.task) : null,
          })),
        });
      }

      case 'list_notifications': {
        if (a.read_all) {
          await tf.markAllNotificationsRead();
          return ok({ ok: true });
        }
        const r = await tf.listNotifications();
        return ok({
          unreadCount: r.unreadCount,
          notifications: r.notifications.slice(0, 50).map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            createdAt: n.createdAt,
            read: Boolean(n.readAt),
          })),
        });
      }

      // ── Write ───────────────────────────────────────────────────────────

      case 'create_task': {
        const { id: projectId } = await tf.resolveProjectKeyAndId(String(a.project_key_or_id));
        let assigneeIds: string[] | undefined;
        const usernames: string[] | undefined = a.assignee_usernames;
        if (Array.isArray(usernames) && usernames.length) {
          const found = await Promise.all(
            usernames.map(async (u) => {
              const r = await tf.searchUsers(u);
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
          dueDate: a.due_date,
          estimateMinutes: a.estimate_minutes,
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

      case 'share_task': {
        const { taskId, task } = await resolveTask(String(a.task_ref));
        const s = await tf.shareTask(taskId);
        return ok({
          taskRef: `${task.project.key}-${task.number}`,
          token: s.token,
          url: s.url,
          expiresInDays: s.expiresInDays,
        });
      }

      case 'bulk_update': {
        const refs: string[] = Array.isArray(a.task_refs) ? a.task_refs : [];
        if (!refs.length) throw new McpError(ErrorCode.InvalidParams, 'task_refs is required');
        if (refs.length > 200) {
          throw new McpError(ErrorCode.InvalidParams, 'bulk_update accepts max 200 task_refs');
        }
        const action = String(a.action);
        if (!['setStatus', 'setPriority', 'delete'].includes(action)) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown action ${action}`);
        }
        const ids: string[] = [];
        for (const r of refs) {
          const { taskId } = await resolveTask(String(r));
          ids.push(taskId);
        }
        const payload: Record<string, string> = {};
        if (action === 'setStatus' && a.status) payload.status = String(a.status);
        if (action === 'setPriority' && a.priority) payload.priority = String(a.priority);
        const r = await tf.bulkUpdate({ taskIds: ids, action: action as any, payload });
        return ok({
          action: r.action,
          processed: r.processed,
          failed: r.failed,
          failures: r.failures,
        });
      }

      // ── Recurrence ──────────────────────────────────────────────────────

      case 'set_recurrence': {
        const { taskId, task } = await resolveTask(String(a.task_ref));
        const r = await tf.setRecurrence(taskId, {
          frequency: String(a.frequency) as any,
          byDay: Array.isArray(a.by_day) ? a.by_day.map(Number) : undefined,
          hourOfDay: a.hour !== undefined ? Number(a.hour) : undefined,
          endsAt: a.ends_at ?? null,
        });
        return ok({
          taskRef: `${task.project.key}-${task.number}`,
          rule: r.rule,
        });
      }

      case 'clear_recurrence': {
        const { taskId, task } = await resolveTask(String(a.task_ref));
        await tf.removeRecurrence(taskId);
        return ok({ ok: true, taskRef: `${task.project.key}-${task.number}` });
      }

      // ── Dependencies ────────────────────────────────────────────────────

      case 'add_dependency': {
        const { taskId, task } = await resolveTask(String(a.task_ref));
        const { taskId: blockerId, task: blocker } = await resolveTask(String(a.depends_on_ref));
        const r = await tf.addDependency(taskId, blockerId);
        return ok({
          taskRef: `${task.project.key}-${task.number}`,
          blockedBy: `${blocker.project.key}-${blocker.number}`,
          dependencyId: r.dependency.id,
        });
      }

      case 'remove_dependency': {
        const { taskId, task } = await resolveTask(String(a.task_ref));
        const { taskId: blockerId, task: blocker } = await resolveTask(String(a.depends_on_ref));
        await tf.removeDependency(taskId, blockerId);
        return ok({
          ok: true,
          taskRef: `${task.project.key}-${task.number}`,
          removedBlocker: `${blocker.project.key}-${blocker.number}`,
        });
      }

      // ── Time tracking ───────────────────────────────────────────────────

      case 'log_time': {
        const { taskId, task } = await resolveTask(String(a.task_ref));
        const minutes = Number(a.minutes);
        if (!minutes || minutes <= 0) {
          throw new McpError(ErrorCode.InvalidParams, 'minutes must be a positive number');
        }
        const r = await tf.logTime(taskId, {
          minutes,
          description: a.description ? String(a.description) : undefined,
          startedAt: a.started_at,
        });
        return ok({
          taskRef: `${task.project.key}-${task.number}`,
          entryId: r.entry.id,
          minutes: r.entry.minutes,
          startedAt: r.entry.startedAt,
        });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (e: any) {
    if (e instanceof McpError) throw e;
    if (e instanceof TrovyError) {
      throw new McpError(
        e.status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest,
        `Trovy API ${e.status}: ${e.message}`,
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

function formatRelated(t: {
  id: string;
  number: number;
  title: string;
  status: string;
  project: { key: string };
}) {
  return {
    ref: `${t.project.key}-${t.number}`,
    id: t.id,
    title: t.title,
    status: t.status,
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

/** Full-detail task (for get_task): includes comments, time entries, etc. */
function formatTaskFull(t: any) {
  const base = formatTask(t);
  return {
    ...base,
    checklists: t.checklists ?? [],
    children: (t.children ?? []).map((c: any) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      order: c.order,
      priority: c.priority,
      assignees: (c.assignees ?? []).map((a: any) => a.user),
    })),
    comments: (t.comments ?? []).map((c: any) => ({
      id: c.id,
      content: c.content,
      author: c.author.name ?? c.author.username ?? c.author.email,
      createdAt: c.createdAt,
      editedAt: c.editedAt,
    })),
    attachments: (t.attachments ?? []).map((att: any) => ({
      id: att.id,
      name: att.name,
      url: att.url,
      size: att.size,
      mimeType: att.mimeType,
      uploadedBy: att.uploader?.name,
      createdAt: att.createdAt,
    })),
    timeEntries: (t.timeEntries ?? []).map((te: any) => ({
      id: te.id,
      minutes: te.minutes,
      description: te.description,
      user: te.user?.name,
      startedAt: te.startedAt,
    })),
    totalTimeMinutes: (t.timeEntries ?? []).reduce(
      (acc: number, te: any) => acc + (te.minutes ?? 0),
      0
    ),
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
  process.stderr.write(`trovy-mcp ready — api=${apiUrl} version=0.2.0\n`);
})().catch((e) => {
  process.stderr.write(`trovy-mcp fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});