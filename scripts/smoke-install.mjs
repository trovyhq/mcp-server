#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'trovy-mcp-pack-'));
const packageDir = path.join(tmp, 'package');
const installDir = path.join(tmp, 'install');
const npmCache = path.join(tmp, 'npm-cache');
mkdirSync(packageDir);
mkdirSync(installDir);
mkdirSync(npmCache);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      ...(options.env ?? {}),
    },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

function sendMessage(child, payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function createMessageReader(stream) {
  let buffer = '';
  const messages = [];
  const pending = [];

  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) return;

      const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;

      const message = JSON.parse(line);
      const next = pending.shift();
      if (next) next(message);
      else messages.push(message);
    }
  });

  return () =>
    new Promise((resolve, reject) => {
      const message = messages.shift();
      if (message) {
        resolve(message);
        return;
      }

      const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 10000);
      pending.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function success(res, data, status = 200) {
  return json(res, status, {
    success: true,
    statusCode: status,
    data,
    timestamp: new Date(0).toISOString(),
  });
}

const project = {
  id: 'project_1',
  name: 'Smoke Project',
  key: 'SMK',
  color: '#111827',
  visibility: 'PRIVATE',
};

let structure = {
  structured: true,
  revision: 1,
  canEdit: true,
  milestones: [{
    id: 'milestone_1',
    reference: 'M1',
    title: 'Planning',
    description: null,
    targetDate: '2026-11-05T00:00:00.000Z',
    clientVisible: false,
  }],
  deliverables: [{
    id: 'deliverable_1',
    reference: 'D1',
    title: 'Approved outcome',
    description: null,
    acceptanceCriteria: ['Accepted'],
    clientVisible: false,
    milestoneRef: 'M1',
    taskIds: [],
  }],
};
let task;
let rejectNextStructurePatch = false;

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer smoke-token') {
    return json(res, 401, { error: 'Unauthorized' });
  }

  if (req.method === 'GET' && req.url === '/api/v1/projects') {
    return success(res, [project]);
  }

  if (req.url === '/api/v1/projects/project_1/delivery-structure') {
    if (req.method === 'GET') return success(res, structure);
    if (req.method === 'PATCH') {
      if (rejectNextStructurePatch) {
        rejectNextStructurePatch = false;
        return json(res, 409, { message: 'Structure changed in another session' });
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.expectedRevision !== structure.revision) {
        return json(res, 409, { message: 'Structure changed' });
      }
      if (body.milestones.some((milestone) =>
        milestone.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(milestone.targetDate))) {
        return json(res, 400, { message: 'milestone targetDate is invalid' });
      }
      if (JSON.stringify(body.deliverables.map(({ id, title, acceptanceCriteria, taskIds }) =>
        ({ id, title, acceptanceCriteria, taskIds }))) !==
        JSON.stringify(structure.deliverables.map(({ id, title, acceptanceCriteria, taskIds }) =>
          ({ id, title, acceptanceCriteria, taskIds })))) {
        return json(res, 400, { message: 'Unrelated deliverables changed' });
      }
      structure = {
        ...structure,
        revision: structure.revision + 1,
        milestones: body.milestones.map((milestone, index) => ({
          ...milestone,
          id: milestone.id ?? `milestone_${index + 1}`,
        })),
        deliverables: body.deliverables,
      };
      if (task?.milestoneId && !structure.milestones.some((item) => item.id === task.milestoneId)) {
        task.milestoneId = null;
      }
      return success(res, structure);
    }
  }

  if (req.method === 'POST' && req.url === '/api/v1/projects/project_1/tasks') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    task = {
        id: 'task_1',
        number: 1,
        title: body.title,
        description: body.description ?? null,
        status: 'TODO',
        priority: body.priority ?? 'MEDIUM',
        type: body.type ?? 'TASK',
        storyPoints: null,
        estimateMinutes: null,
        dueDate: null,
        startDate: null,
        completedAt: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        projectId: project.id,
        milestoneId: body.milestoneId ?? null,
        creatorId: 'user_1',
        githubIssueNumber: null,
        githubIssueUrl: null,
        githubPrUrl: null,
        project,
        assignees: [],
        labels: [],
      };
    return success(res, { task });
  }

  if (req.url === '/api/v1/tasks/task_1') {
    if (req.method === 'GET') return success(res, { task });
    if (req.method === 'PATCH') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      task = { ...task, ...JSON.parse(raw) };
      return success(res, { task });
    }
  }

  return json(res, 404, { error: `Unhandled ${req.method} ${req.url}` });
});

let child;

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const packJson = run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packageDir,
  ]);
  const [packed] = JSON.parse(packJson);
  const tarball = path.join(packageDir, packed.filename);

  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--fund=false', tarball], {
    cwd: installDir,
  });

  const bin = path.join(installDir, 'node_modules', '.bin', 'trovy-mcp');
  child = spawn(bin, [], {
    cwd: installDir,
    env: {
      ...process.env,
      TROVY_API_URL: `http://127.0.0.1:${port}`,
      TROVY_TOKEN: 'smoke-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const readMessage = createMessageReader(child.stdout);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  sendMessage(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'trovy-pack-smoke', version: '1.0.0' },
    },
  });
  const initialized = await readMessage();
  if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);

  sendMessage(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

  sendMessage(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await readMessage();
  if (tools.error) throw new Error(`tools/list failed: ${JSON.stringify(tools.error)}`);
  for (const name of [
    'create_task', 'list_project_milestones', 'create_project_milestone',
    'update_project_milestone', 'delete_project_milestone', 'set_task_milestone',
  ]) {
    if (!tools.result.tools.some((tool) => tool.name === name)) {
      throw new Error(`${name} tool missing from installed MCP server`);
    }
  }

  let nextId = 3;
  async function callToolResult(name, args) {
    sendMessage(child, {
      jsonrpc: '2.0', id: nextId++, method: 'tools/call',
      params: { name, arguments: args },
    });
    return readMessage();
  }
  async function callTool(name, args) {
    const response = await callToolResult(name, args);
    if (response.error) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
    return JSON.parse(response.result.content[0].text);
  }

  const listProjects = await callTool('list_projects', {});
  if (listProjects[0]?.key !== project.key) throw new Error('list_projects returned the wrong project');

  const listed = await callTool('list_project_milestones', { project_key_or_id: 'SMK' });
  if (listed.count !== 1 || listed.milestones[0].reference !== 'M1') {
    throw new Error('list_project_milestones returned an invalid projection');
  }

  const createdMilestone = await callTool('create_project_milestone', {
    project_key_or_id: 'SMK', title: 'Delivery', target_date: '2026-11-20',
  });
  if (createdMilestone.milestone.reference !== 'M2' || createdMilestone.milestone.clientVisible) {
    throw new Error('create_project_milestone did not create a private milestone');
  }

  const updatedMilestone = await callTool('update_project_milestone', {
    project_key_or_id: 'SMK', milestone_ref_or_id: 'M2',
    description: 'Final review', target_date: null,
  });
  if (updatedMilestone.milestone.description !== 'Final review' ||
      updatedMilestone.milestone.targetDate !== null) {
    throw new Error('update_project_milestone did not update and clear fields');
  }

  const invalidDate = await callToolResult('update_project_milestone', {
    project_key_or_id: 'SMK', milestone_ref_or_id: 'M2', target_date: '2026-02-30',
  });
  if (!invalidDate.error) throw new Error('An invalid target date was accepted');

  rejectNextStructurePatch = true;
  const staleRevision = await callToolResult('update_project_milestone', {
    project_key_or_id: 'SMK', milestone_ref_or_id: 'M2', title: 'Stale update',
  });
  if (!staleRevision.error || structure.milestones[1].title === 'Stale update') {
    throw new Error('A concurrent structure change was not rejected');
  }

  const createTask = await callTool('create_task', {
    project_key_or_id: 'SMK', title: 'Smoke task', priority: 'HIGH',
    milestone_ref_or_id: 'M1',
  });
  if (createTask.milestoneId !== 'milestone_1') {
    throw new Error('create_task did not assign the selected milestone');
  }

  const reassigned = await callTool('set_task_milestone', {
    task_ref: 'task_1', milestone_ref_or_id: 'M2',
  });
  if (reassigned.milestoneId !== createdMilestone.milestone.id) {
    throw new Error('set_task_milestone did not reassign the task');
  }

  const clearedByAssignment = await callTool('set_task_milestone', {
    task_ref: 'task_1', clear: true,
  });
  if (clearedByAssignment.milestoneId !== null) {
    throw new Error('set_task_milestone did not clear the task');
  }

  const updatedTask = await callTool('update_task', {
    task_ref: 'task_1', milestone_ref_or_id: 'M1',
  });
  if (updatedTask.milestoneId !== 'milestone_1') {
    throw new Error('update_task did not assign the milestone');
  }

  const cleared = await callTool('update_task', {
    task_ref: 'task_1', clear_milestone: true,
  });
  if (cleared.milestoneId !== null) throw new Error('update_task did not clear the milestone');

  const deletedMilestone = await callTool('delete_project_milestone', {
    project_key_or_id: 'SMK', milestone_ref_or_id: 'M2',
  });
  if (deletedMilestone.deleted !== 'M2' || structure.milestones.length !== 1 ||
      structure.deliverables[0].reference !== 'D1') {
    throw new Error('delete_project_milestone changed unrelated delivery data');
  }

  await callTool('set_task_milestone', { task_ref: 'task_1', milestone_ref_or_id: 'M1' });

  const deletedLinked = await callTool('delete_project_milestone', {
    project_key_or_id: 'SMK', milestone_ref_or_id: 'M1',
  });
  if (deletedLinked.unlinkedDeliverables !== 1 ||
      structure.deliverables[0].milestoneRef !== null || structure.deliverables.length !== 1 ||
      task.milestoneId !== null) {
    throw new Error('delete_project_milestone did not preserve and ungroup linked deliverables');
  }

  child.kill();
  console.log('Fresh tarball install smoke test passed.');
} finally {
  child?.kill();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
