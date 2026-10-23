/**
 * dsh-clock-tools 单元测试（mock ctx，不依赖真实 DSH 进程）。
 * 运行：ELECTRON_RUN_AS_NODE=1 "<DSH exe>" --test test/unit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, _internals } from '../index.js';

const BASE_WALL = 1_792_750_000_000;
const BASE_MONO = 1000;

function makeHarness({ roots = ['root'] } = {}) {
  const tools = [];
  const created = [];
  const agentMap = new Map();
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on(event, fn) {
      if (event === 'agent/created') created.push(fn);
      return () => {};
    },
    effect(fn) {
      fn();
      return () => {};
    },
    agents: {
      roots: () => roots.map((id) => agentMap.get(id)).filter(Boolean),
    },
  };
  function makeAgent(id) {
    const agent = {
      id,
      session: { id: `session-${id}` },
      ctx: {
        effect: (fn) => fn(),
        tools: {
          register(tool) {
            tools.push(tool);
            return () => {};
          },
        },
      },
    };
    agentMap.set(id, agent);
    return agent;
  }
  return { ctx, tools, created, makeAgent };
}

function startup(options = {}) {
  _internals.setClock({ wall: () => BASE_WALL, mono: () => BASE_MONO });
  _internals.setBootId('boot-A');
  const h = makeHarness(options);
  apply(h.ctx, { storeDir: mkdtempSync(join(tmpdir(), 'clock-tools-test-')) });
  return h;
}

test('顶层 Agent 注册 task_clock；子 Agent 默认不注册', () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  const child = h.makeAgent('child');
  h.created[0]({ agent: root });
  h.created[0]({ agent: child });
  assert.equal(h.tools.length, 1);
  assert.equal(h.tools[0].name, 'task_clock');
});

test('task_clock start/check/finish/list 返回可核实耗时', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  const tool = h.tools[0];

  const started = await tool.execute({ action: 'start', plannedSeconds: 1200, label: '写报告' }, { agent: root });
  assert.match(started.text, /running/);
  assert.match(started.text, /Planned: 20m 0s/);

  _internals.setClock({ wall: () => BASE_WALL + 118_000, mono: () => BASE_MONO + 118_000 });
  const checked = await tool.execute({ action: 'check' }, { agent: root });
  assert.match(checked.text, /Elapsed: 1m 58s \(monotonic/);
  assert.match(checked.text, /remaining: 18m 2s/);

  const finished = await tool.execute({ action: 'finish' }, { agent: root });
  assert.match(finished.text, /completed/);
  assert.match(finished.text, /Actual: 1m 58s \(monotonic/);
  assert.match(finished.text, /Variance: -18m 2s/);

  const listed = await tool.execute({ action: 'list' }, { agent: root });
  assert.match(listed.text, /completed/);
});

test('跨 turn 记录保持：同一 session 新 turn 仍能 list', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  const tool = h.tools[0];
  await tool.execute({ action: 'start', plannedSeconds: 60 }, { agent: root });
  _internals.setClock({ wall: () => BASE_WALL + 30_000, mono: () => BASE_MONO + 30_000 });
  await tool.execute({ action: 'finish' }, { agent: root });

  // 模拟新 turn（工具本身不依赖 turn 状态）
  const listed = await tool.execute({ action: 'list' }, { agent: root });
  assert.match(listed.text, /completed/);
  assert.match(listed.text, /actual 30s/);
});

test('进程重启：标记 restarted 并用墙钟估算', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  const tool = h.tools[0];
  await tool.execute({ action: 'start', plannedSeconds: 600 }, { agent: root });

  _internals.setBootId('boot-B');
  _internals.setClock({ wall: () => BASE_WALL + 300_000, mono: () => 10 });
  const finished = await tool.execute({ action: 'finish' }, { agent: root });
  assert.match(finished.text, /restarted/);
  assert.match(finished.text, /Actual: 5m 0s \(wall clock, process restarted\)/);
});

test('墙钟跳变：实际耗时用单调时钟并标注', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  const tool = h.tools[0];
  await tool.execute({ action: 'start', plannedSeconds: 60 }, { agent: root });

  _internals.setClock({ wall: () => BASE_WALL + 600_000, mono: () => BASE_MONO + 1000 });
  const finished = await tool.execute({ action: 'finish' }, { agent: root });
  assert.match(finished.text, /Actual: 1s \(monotonic; wall clock changed\)/);
});

test('墙钟回退：不编造耗时', () => {
  const record = {
    taskId: 't1', sessionId: 's1', label: null, status: 'running', plannedMs: null,
    startedWall: BASE_WALL, startedMono: 500, bootId: 'boot-A',
    endedWall: null, endedMono: null, actualMs: null, wallJump: false,
    continuity: 'continuous', createdAt: BASE_WALL,
  };
  _internals.setBootId('boot-B');
  const elapsed = _internals.computeElapsed(record, BASE_WALL - 10_000, 100);
  assert.equal(elapsed.elapsedMs, null);
  assert.equal(elapsed.continuity, 'unknown');
});

test('日常聊天不创建任务记录', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  const listed = await h.tools[0].execute({ action: 'list' }, { agent: root });
  assert.match(listed.text, /No task records\./);
});

test('task_clock now 返回当前时刻与时区', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  const now = await h.tools[0].execute({ action: 'now' }, { agent: root });
  assert.match(now.text, /^Now: 2026-10-23T/);
  assert.match(now.text, /\[Asia\/Shanghai\]/);
  assert.doesNotMatch(now.text, /Running task/);
});

test('task_clock now 附带 running 任务耗时', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  await h.tools[0].execute({ action: 'start', plannedSeconds: 60 }, { agent: root });
  _internals.setClock({ wall: () => BASE_WALL + 5000, mono: () => BASE_MONO + 5000 });
  const now = await h.tools[0].execute({ action: 'now' }, { agent: root });
  assert.match(now.text, /Running task t-/);
  assert.match(now.text, /5s elapsed/);
});
