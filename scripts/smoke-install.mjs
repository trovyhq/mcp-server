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

const project = {
  id: 'project_1',
  name: 'Smoke Project',
  key: 'SMK',
  color: '#111827',
  visibility: 'PRIVATE',
};

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer smoke-token') {
    return json(res, 401, { error: 'Unauthorized' });
  }

  if (req.method === 'GET' && req.url === '/api/projects') {
    return json(res, 200, { projects: [project] });
  }

  if (req.method === 'POST' && req.url === '/api/projects/project_1/tasks') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    return json(res, 200, {
      task: {
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
        creatorId: 'user_1',
        githubIssueNumber: null,
        githubIssueUrl: null,
        githubPrUrl: null,
        project,
        assignees: [],
        labels: [],
      },
    });
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
  if (!tools.result.tools.some((tool) => tool.name === 'create_task')) {
    throw new Error('create_task tool missing from installed MCP server');
  }

  sendMessage(child, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_projects', arguments: {} },
  });
  const listProjects = await readMessage();
  if (listProjects.error) throw new Error(`list_projects failed: ${JSON.stringify(listProjects.error)}`);

  sendMessage(child, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'create_task',
      arguments: {
        project_key_or_id: 'SMK',
        title: 'Smoke task',
        priority: 'HIGH',
      },
    },
  });
  const createTask = await readMessage();
  if (createTask.error) throw new Error(`create_task failed: ${JSON.stringify(createTask.error)}`);

  child.kill();
  console.log('Fresh tarball install smoke test passed.');
} finally {
  child?.kill();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
