/**
 * dsh-clock-tools — 任务计时的独立插件（第一层：Clock Tools）。
 *
 * 只提供 `task_clock`（start / check / finish / list / now），不注入任何时间消息、
 * 不覆盖任何 preset。通过 `agent/created` 把工具注册到每个顶层 Agent 的
 * 作用域，因此在同一 Profile 下使用不同 preset 的 Agent 都能用。
 *
 * 零 DSH 包依赖：只用 node 内置模块与 ctx 服务。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, uptime as osUptime } from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'clock-tools';
export const inject = ['agents', 'tools'];

let bootId = randomUUID();
let clock = {
  wall: () => Date.now(),
  mono: () => performance.now(),
  uptime: () => osUptime(),
  startMono: 0,
  startUptime: 0,
};
clock.startMono = clock.mono();
clock.startUptime = clock.uptime();

const WALL_JUMP_THRESHOLD_MS = 2000;
const BOOT_TOLERANCE_MS = 2000;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;

const TASK_STATUS = new Set(['running', 'completed', 'aborted', 'uncertain']);
const CONTINUITY = new Set(['continuous', 'resumed', 'restarted', 'clock-changed', 'unknown']);

// ---------------------------------------------------------------------------
// 时间格式化
// ---------------------------------------------------------------------------

function createTimestampFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    ...timeZone === undefined ? {} : { timeZone },
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
}

function formatTimestamp(now, formatter, timeZone) {
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${timeZone}]`;
}

function formatDuration(elapsedMs) {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatSignedMs(ms) {
  return `${ms < 0 ? '-' : '+'}${formatDuration(Math.abs(ms))}`;
}

function resolveZone(timeZone) {
  const base = new Intl.DateTimeFormat('en-US', timeZone === undefined ? {} : { timeZone });
  return { zone: base.resolvedOptions().timeZone, formatter: createTimestampFormatter(timeZone) };
}

// ---------------------------------------------------------------------------
// 任务记录
// ---------------------------------------------------------------------------

function normalizeTask(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  if (typeof raw.taskId !== 'string' || typeof raw.sessionId !== 'string') return undefined;
  if (!TASK_STATUS.has(raw.status) || !CONTINUITY.has(raw.continuity)) return undefined;
  if (typeof raw.startedWall !== 'number' || typeof raw.createdAt !== 'number') return undefined;
  return {
    taskId: raw.taskId,
    sessionId: raw.sessionId,
    label: typeof raw.label === 'string' ? raw.label : null,
    status: raw.status,
    plannedMs: typeof raw.plannedMs === 'number' ? raw.plannedMs : null,
    startedWall: raw.startedWall,
    startedMono: typeof raw.startedMono === 'number' ? raw.startedMono : null,
    startedUptime: typeof raw.startedUptime === 'number' ? raw.startedUptime : null,
    startedBootWall: typeof raw.startedBootWall === 'number' ? raw.startedBootWall : null,
    lastSeenUptime: typeof raw.lastSeenUptime === 'number' ? raw.lastSeenUptime : null,
    lastSeenMono: typeof raw.lastSeenMono === 'number' ? raw.lastSeenMono : null,
    lastSeenBootId: typeof raw.lastSeenBootId === 'string' ? raw.lastSeenBootId : '',
    bootId: typeof raw.bootId === 'string' ? raw.bootId : '',
    endedWall: typeof raw.endedWall === 'number' ? raw.endedWall : null,
    endedMono: typeof raw.endedMono === 'number' ? raw.endedMono : null,
    actualMs: typeof raw.actualMs === 'number' ? raw.actualMs : null,
    wallJump: raw.wallJump === true,
    continuity: raw.continuity,
    createdAt: raw.createdAt,
  };
}

function newTaskId() {
  return `t-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function computeElapsed(record, nowWall, nowMono) {
  const nowUptime = clock.uptime();
  const nowBootWall = nowWall - nowUptime * 1000;
  const elapsedWall = nowWall - record.startedWall;

  // 同一进程：单调时钟，最高精度。
  if (record.bootId === bootId && record.startedMono !== null) {
    const elapsedMono = Math.max(0, nowMono - record.startedMono);
    const wallJump = Math.abs(elapsedWall - elapsedMono) > WALL_JUMP_THRESHOLD_MS;
    return {
      elapsedMs: elapsedMono,
      basis: 'monotonic',
      continuity: wallJump ? 'clock-changed' : 'continuous',
      wallJump,
    };
  }

  // 同一系统启动周期、跨 DSH 进程：用系统运行时间桥接空档。
  const sameBoot = typeof record.startedBootWall === 'number'
    && Math.abs(nowBootWall - record.startedBootWall) <= BOOT_TOLERANCE_MS;
  if (
    sameBoot
    && record.lastSeenBootId === record.bootId
    && typeof record.lastSeenUptime === 'number'
    && typeof record.lastSeenMono === 'number'
    && record.startedMono !== null
  ) {
    const segBefore = record.lastSeenMono - record.startedMono;
    const segGap = (clock.startUptime - record.lastSeenUptime) * 1000;
    const segAfter = nowMono - clock.startMono;
    if (segBefore >= 0 && segGap >= 0 && segAfter >= 0) {
      const elapsed = segBefore + segGap + segAfter;
      return {
        elapsedMs: elapsed,
        basis: 'uptime-bridge',
        continuity: 'resumed',
        wallJump: Math.abs(elapsedWall - elapsed) > WALL_JUMP_THRESHOLD_MS,
      };
    }
  }

  // 系统重启过或无法桥接：墙钟估算。
  if (elapsedWall < 0) return { elapsedMs: null, basis: 'unknown', continuity: 'unknown', wallJump: true };
  return { elapsedMs: elapsedWall, basis: 'wall-clock', continuity: 'restarted', wallJump: false };
}

function continuityNote(continuity) {
  if (continuity === 'resumed') return 'DSH restarted during this task; elapsed was bridged with system uptime (same OS session).';
  if (continuity === 'restarted') return 'DSH restarted during this task; the monotonic clock did not survive, so elapsed is a wall-clock estimate.';
  if (continuity === 'clock-changed') return 'the wall clock changed during this task; elapsed uses the monotonic clock.';
  return 'clock continuity is unknown; elapsed may be unreliable.';
}

function continuityBasis(continuity) {
  if (continuity === 'continuous') return 'monotonic, host-measured';
  if (continuity === 'resumed') return 'resumed, uptime-bridged';
  if (continuity === 'restarted') return 'wall clock, restarted';
  if (continuity === 'clock-changed') return 'monotonic; wall clock changed';
  return 'unknown';
}

export function apply(ctx, config = {}) {
  const resolved = resolveZone(config?.timeZone || undefined);
  const zone = resolved.zone;
  const formatter = resolved.formatter;

  const tasks = new Map();
  const sessionTasks = new Map();
  const fileDir = config?.storeDir ?? join(homedir(), '.dsh', 'clock-context');
  const filePath = join(fileDir, 'tasks.json');
  let fileWriteChain = Promise.resolve();
  let storeReady = Promise.resolve();

  function persist() {
    fileWriteChain = fileWriteChain.then(async () => {
      await mkdir(fileDir, { recursive: true });
      const snapshot = [...tasks.values()];
      const tmp = `${filePath}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
      await rename(tmp, filePath);
    }).catch((error) => {
      ctx.logger?.warn?.('clock-tools: file persist failed: %s', error?.message ?? String(error));
    });
  }

  function remember(record) {
    tasks.set(record.taskId, record);
    if (record.status === 'running') sessionTasks.set(record.sessionId, record.taskId);
    else if (sessionTasks.get(record.sessionId) === record.taskId) sessionTasks.delete(record.sessionId);
    persist();
  }

  function markSeen(record, nowMono) {
    // 跨进程记录保留旧进程的最后锚点：它是 uptime 桥接的起点，不能被新进程覆盖。
    if (record.bootId !== bootId) return;
    record.lastSeenUptime = clock.uptime();
    record.lastSeenMono = nowMono;
    record.lastSeenBootId = bootId;
    persist();
  }

  async function loadStore() {
    try {
      const text = await readFile(filePath, 'utf8');
      const list = JSON.parse(text);
      for (const raw of Array.isArray(list) ? list : []) {
        const record = normalizeTask(raw);
        if (record !== undefined) tasks.set(record.taskId, record);
      }
      for (const record of tasks.values()) {
        if (record.status === 'running') sessionTasks.set(record.sessionId, record.taskId);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger?.warn?.('clock-tools: task store read failed: %s', error?.message ?? String(error));
      }
    }
  }

  storeReady = loadStore().catch((error) => {
    ctx.logger?.warn?.('clock-tools: store init failed: %s', error?.message ?? String(error));
  });

  function taskFor(sessionId, taskId) {
    if (taskId !== undefined) return tasks.get(taskId);
    const runningId = sessionTasks.get(sessionId);
    return runningId === undefined ? undefined : tasks.get(runningId);
  }

  function describeRunning(record, nowWall, nowMono) {
    const elapsed = computeElapsed(record, nowWall, nowMono);
    const lines = [
      `Task ${record.taskId}${record.label ? ` (${record.label})` : ''}: running`,
      `Started: ${formatTimestamp(record.startedWall, formatter, zone)}`,
      `Elapsed: ${elapsed.elapsedMs === null ? 'unknown' : formatDuration(elapsed.elapsedMs)} (${continuityBasis(elapsed.continuity)})`,
    ];
    if (record.plannedMs !== null) {
      const remaining = record.plannedMs - (elapsed.elapsedMs ?? 0);
      lines.push(`Planned: ${formatDuration(record.plannedMs)}; remaining: ${remaining < 0 ? 'over by ' + formatDuration(-remaining) : formatDuration(remaining)}`);
    }
    if (elapsed.continuity !== 'continuous') lines.push(`Timing note: ${continuityNote(elapsed.continuity)}`);
    return lines.join('\n');
  }

  function describeFinished(record) {
    const lines = [
      `Task ${record.taskId}${record.label ? ` (${record.label})` : ''}: ${record.status}`,
      `Started: ${formatTimestamp(record.startedWall, formatter, zone)}`,
    ];
    if (record.endedWall !== null) lines.push(`Ended: ${formatTimestamp(record.endedWall, formatter, zone)}`);
    lines.push(`Actual: ${record.actualMs === null ? 'unknown (clock continuity lost)' : formatDuration(record.actualMs)} (${continuityBasis(record.continuity)})`);
    if (record.plannedMs !== null) {
      lines.push(`Planned: ${formatDuration(record.plannedMs)}`);
      if (record.actualMs !== null) {
        const note = record.continuity === 'continuous' ? '' : record.continuity === 'resumed' ? ' (resumed)' : ' (estimated)';
        lines.push(`Variance: ${formatSignedMs(record.actualMs - record.plannedMs)}${note}`);
      }
    }
    if (record.continuity !== 'continuous') lines.push(`Timing note: ${continuityNote(record.continuity)}`);
    return lines.join('\n');
  }

  const taskClockTool = {
    name: 'task_clock',
    description:
      'Use only when current time or task duration matters, not for ordinary chat. '
      + 'now returns the current local date/time and time zone; call it before stating the current time—never guess. '
      + 'start records the planned duration; check reports elapsed and remaining; finish records actual duration and variance; list shows saved tasks. '
      + 'Elapsed time is host-measured, never inferred from chat history. '
      + 'It uses a monotonic clock while the process is continuous; after a DSH restart within the same OS session it bridges the gap with system uptime, and after an OS restart it may be an estimate or unknown. '
      + 'It does not automatically start tasks or cancel timed-out work.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'check', 'finish', 'list', 'now'], description: 'start | check | finish | list | now' },
        taskId: { type: 'string', description: "Task id; check/finish default to this session's running task." },
        plannedSeconds: { type: 'number', description: 'Expected seconds (start).' },
        label: { type: 'string', description: 'Optional label (start).' },
        outcome: { type: 'string', enum: ['completed', 'aborted'], description: 'finish result: completed (default) or aborted.' },
        limit: { type: 'integer', description: 'list: max records (default 10, max 50).' },
        allSessions: { type: 'boolean', description: 'list: include other sessions.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id;
      if (typeof sessionId !== 'string') throw new Error('task_clock requires an owning agent session');
      await storeReady;

      const nowWall = clock.wall();
      const nowMono = clock.mono();

      if (args.action === 'now') {
        const running = taskFor(sessionId);
        const lines = [`Now: ${formatTimestamp(nowWall, formatter, zone)}`];
        if (running?.status === 'running') {
          const elapsed = computeElapsed(running, nowWall, nowMono);
          lines.push(`Running task ${running.taskId}: ${elapsed.elapsedMs === null ? 'unknown' : formatDuration(elapsed.elapsedMs)} elapsed`);
          markSeen(running, nowMono);
        }
        return { text: lines.join('\n') };
      }

      if (args.action === 'start') {
        const existing = taskFor(sessionId, args.taskId);
        if (existing?.status === 'running') return { text: describeRunning(existing, nowWall, nowMono) };
        const startedUptime = clock.uptime();
        const record = {
          taskId: args.taskId ?? newTaskId(),
          sessionId,
          label: args.label ?? null,
          status: 'running',
          plannedMs: typeof args.plannedSeconds === 'number' && args.plannedSeconds > 0 ? Math.round(args.plannedSeconds * 1000) : null,
          startedWall: nowWall,
          startedMono: nowMono,
          startedUptime,
          startedBootWall: nowWall - startedUptime * 1000,
          lastSeenUptime: startedUptime,
          lastSeenMono: nowMono,
          lastSeenBootId: bootId,
          bootId,
          endedWall: null,
          endedMono: null,
          actualMs: null,
          wallJump: false,
          continuity: 'continuous',
          createdAt: nowWall,
        };
        remember(record);
        return { text: describeRunning(record, nowWall, nowMono) };
      }

      if (args.action === 'check') {
        const record = taskFor(sessionId, args.taskId);
        if (record === undefined) return { text: 'No matching task record. Start one with task_clock action=start.' };
        if (record.status !== 'running') return { text: describeFinished(record) };
        const text = describeRunning(record, nowWall, nowMono);
        markSeen(record, nowMono);
        return { text };
      }

      if (args.action === 'finish') {
        const record = taskFor(sessionId, args.taskId);
        if (record === undefined) return { text: 'No matching task record. Start one with task_clock action=start.' };
        if (record.status !== 'running') return { text: describeFinished(record) };
        const elapsed = computeElapsed(record, nowWall, nowMono);
        const outcome = args.outcome ?? 'completed';
        const status = elapsed.continuity === 'unknown' ? 'uncertain' : outcome;
        const updated = {
          ...record,
          status,
          endedWall: nowWall,
          endedMono: nowMono,
          actualMs: elapsed.elapsedMs,
          wallJump: elapsed.wallJump,
          continuity: elapsed.continuity,
        };
        remember(updated);
        return { text: describeFinished(updated) };
      }

      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number.isInteger(args.limit) ? args.limit : DEFAULT_LIST_LIMIT));
      const records = [...tasks.values()]
        .filter((record) => args.allSessions === true || record.sessionId === sessionId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
      if (records.length === 0) return { text: 'No task records.' };
      const lines = [`Recent tasks (${records.length}):`];
      for (const record of records) {
        let duration;
        if (record.status === 'running') {
          const elapsed = computeElapsed(record, nowWall, nowMono);
          markSeen(record, nowMono);
          if (elapsed.elapsedMs === null) {
            duration = 'unknown';
          } else {
            const note = elapsed.continuity === 'continuous'
              ? ''
              : elapsed.continuity === 'resumed'
                ? ' (resumed, uptime-bridged)'
                : elapsed.continuity === 'restarted'
                  ? ' (restarted, estimated)'
                  : elapsed.continuity === 'clock-changed'
                    ? ' (wall clock changed)'
                    : ' (unknown)';
            duration = `${formatDuration(elapsed.elapsedMs)}+${note}`;
          }
        } else {
          duration = record.actualMs === null ? 'unknown' : formatDuration(record.actualMs);
        }
        const planned = record.plannedMs === null ? '' : ` / planned ${formatDuration(record.plannedMs)}`;
        lines.push(`- ${record.taskId} [${record.status}] actual ${duration}${planned}${record.label ? ` — ${record.label}` : ''}`);
      }
      return { text: lines.join('\n') };
    },
  };

  // 每个顶层 Agent 注册一次；子 Agent 默认不注册（避免无谓的 schema 开销）。
  const includeSubagents = config?.includeSubagents === true;
  const owned = new Map();

  ctx.on('agent/created', ({ agent }) => {
    if (!includeSubagents && !ctx.agents.roots().includes(agent)) return;
    const dispose = agent.ctx.effect(() => {
      const off = agent.ctx.tools.register(taskClockTool);
      return () => off();
    });
    owned.set(agent.id, dispose);
  });

  ctx.effect(() => () => {
    for (const dispose of owned.values()) dispose();
    owned.clear();
  });
}

export const _internals = {
  formatDuration,
  formatSignedMs,
  formatTimestamp,
  computeElapsed,
  normalizeTask,
  setBootId: (next) => { bootId = next; },
  setClock: (next) => { clock = { ...clock, ...next }; },
};
