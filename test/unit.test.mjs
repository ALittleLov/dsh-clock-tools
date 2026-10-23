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
  assert.match(finished.text, /Actual: 5m 0s \(wall clock, restarted\)/);
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

test('list 对 running 任务使用单调时钟（墙钟跳变不影响）', async () => {
  const h = startup({ roots: ['root'] });
  const root = h.makeAgent('root');
  h.created[0]({ agent: root });
  await h.tools[0].execute({ action: 'start', plannedSeconds: 60 }, { agent: root });
  _internals.setClock({ wall: () => BASE_WALL + 600_000, mono: () => BASE_MONO + 1000 });
  const listed = await h.tools[0].execute({ action: 'list' }, { agent: root });
  assert.match(listed.text, /actual 1s\+/);
  assert.doesNotMatch(listed.text, /10m/);
});

// ---- 0.1.5：accumulatedMs + 基准 的分段计时 ----

function segmentedRecord({ accumulatedMs = 10_000, baseUptime = 1000, baseWall = BASE_WALL } = {}) {
  return {
    taskId: 't1', sessionId: 's1', label: null, status: 'running', plannedMs: 60_000,
    startedWall: BASE_WALL, startedMono: 100, bootId: 'boot-old',
    startedUptime: baseUptime, startedBootWall: BASE_WALL - baseUptime * 1000,
    lastSeenUptime: baseUptime, lastSeenMono: 10_100, lastSeenWall: baseWall, lastSeenBootId: 'boot-old',
    accumulatedMs, baseBootId: 'boot-old', baseMono: 100, baseUptime,
    baseWall, baseBootWall: baseWall - baseUptime * 1000,
    endedWall: null, endedMono: null, actualMs: null, wallJump: false,
    continuity: 'continuous', createdAt: BASE_WALL,
  };
}

test('分段不重复：跨 DSH 重启 = 累计 + 到新进程启动的空档 + 新进程耗时', () => {
  const record = segmentedRecord();
  const wall = BASE_WALL + 20_300;
  _internals.setBootId('boot-new');
  _internals.setClock({ wall: () => wall, mono: () => 300, uptime: () => 1020.3, startMono: 0, startUptime: 1020, startWall: wall });
  const elapsed = _internals.computeElapsed(record, wall, 300);
  // 10000 + (1020 - 1000) * 1000 + 300 = 30300
  assert.equal(elapsed.continuity, 'resumed');
  assert.equal(elapsed.elapsedMs, 30_300);
});

test('系统重启：累计 + 到新进程启动的空档 + 新进程耗时，标 gap estimated', () => {
  const record = segmentedRecord();
  const wall = BASE_WALL + 60_000;
  _internals.setBootId('boot-new');
  _internals.setClock({ wall: () => wall, mono: () => 50, uptime: () => 30, startMono: 0, startUptime: 30, startWall: wall });
  const elapsed = _internals.computeElapsed(record, wall, 50);
  // 10000 + 60000 + 50 = 70050
  assert.equal(elapsed.continuity, 'resumed-gap');
  assert.equal(elapsed.elapsedMs, 70_050);
  assert.equal(elapsed.gapEstimated, true);
});

test('连续两次 DSH 重启：累计值不重复', () => {
  const record = segmentedRecord();
  const wall1 = BASE_WALL + 20_300;
  _internals.setBootId('boot-b');
  _internals.setClock({ wall: () => wall1, mono: () => 300, uptime: () => 1020.3, startMono: 0, startUptime: 1020, startWall: wall1 });
  const e1 = _internals.computeElapsed(record, wall1, 300);
  assert.equal(e1.elapsedMs, 30_300);

  // 模拟检查点：基准更新为当前
  record.accumulatedMs = e1.elapsedMs;
  record.baseBootId = 'boot-b';
  record.baseMono = 300;
  record.baseUptime = 1020.3;
  record.baseWall = wall1;
  record.baseBootWall = wall1 - 1020.3 * 1000;

  const wall2 = wall1 + 5_000;
  _internals.setBootId('boot-c');
  _internals.setClock({ wall: () => wall2, mono: () => 200, uptime: () => 1025.3, startMono: 0, startUptime: 1025, startWall: wall2 });
  const e2 = _internals.computeElapsed(record, wall2, 200);
  // 30300 + (1025 - 1020.3) * 1000 + 200 = 35200（浮点容差）
  assert.equal(e2.continuity, 'resumed');
  assert.ok(Math.abs(e2.elapsedMs - 35_200) < 1, `expected ~35200, got ${e2.elapsedMs}`);
});

test('墙钟回退且无法桥接：不编造耗时', () => {
  const record = segmentedRecord();
  const wall = BASE_WALL - 10_000;
  _internals.setBootId('boot-new');
  _internals.setClock({ wall: () => wall, mono: () => 100, uptime: () => 30, startMono: 0, startUptime: 30, startWall: wall });
  const elapsed = _internals.computeElapsed(record, wall, 100);
  assert.equal(elapsed.elapsedMs, null);
  assert.equal(elapsed.continuity, 'unknown');
});

// ---- Linux boot_id 分支（Windows 上模拟；真实 Linux 未测） ----

test('Linux boot_id 相同：即使墙钟推断不成立也判定同一系统启动', () => {
  try {
    const record = segmentedRecord();
    record.platformBootId = 'linux-boot-a';
    _internals.setPlatformBootId('linux-boot-a');
    const wall = BASE_WALL + 20_300;
    _internals.setBootId('boot-new');
    // uptime=30 会让墙钟推断认为系统重启，但 boot_id 相同应优先
    _internals.setClock({ wall: () => wall, mono: () => 300, uptime: () => 30, startMono: 0, startUptime: 1020, startWall: wall });
    const elapsed = _internals.computeElapsed(record, wall, 300);
    assert.equal(elapsed.continuity, 'resumed');
    assert.equal(elapsed.elapsedMs, 30_300);
  } finally {
    _internals.setPlatformBootId(null);
  }
});

test('Linux boot_id 不同：判定系统重启，标 resumed-gap', () => {
  try {
    const record = segmentedRecord();
    record.platformBootId = 'linux-boot-a';
    _internals.setPlatformBootId('linux-boot-b');
    const wall = BASE_WALL + 60_000;
    _internals.setBootId('boot-new');
    _internals.setClock({ wall: () => wall, mono: () => 50, uptime: () => 30, startMono: 0, startUptime: 30, startWall: wall });
    const elapsed = _internals.computeElapsed(record, wall, 50);
    assert.equal(elapsed.continuity, 'resumed-gap');
    assert.equal(elapsed.elapsedMs, 70_050);
  } finally {
    _internals.setPlatformBootId(null);
  }
});

