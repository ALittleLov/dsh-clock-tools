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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, uptime as osUptime } from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'clock-tools';
export const inject = ['agents', 'tools'];

// Linux 每次系统启动生成一个新 boot_id；Windows/macOS 没有这个文件，读取失败返回 null。
function readPlatformBootId() {
  if (process.platform !== 'linux') return null;
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

let platformBootId = readPlatformBootId();

let bootId = randomUUID();
let clock = {
  wall: () => Date.now(),
  mono: () => performance.now(),
  uptime: () => osUptime(),
  startMono: 0,
  startUptime: 0,
  startWall: 0,
};
clock.startMono = clock.mono();
clock.startUptime = clock.uptime();
clock.startWall = clock.wall();

const WALL_JUMP_THRESHOLD_MS = 2000;
const BOOT_TOLERANCE_MS = 2000;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;

const TASK_STATUS = new Set(['running', 'completed', 'aborted', 'uncertain']);
const CONTINUITY = new Set(['continuous', 'resumed', 'resumed-gap', 'restarted', 'clock-changed', 'unknown']);

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
    lastSeenWall: typeof raw.lastSeenWall === 'number' ? raw.lastSeenWall : null,
    lastSeenBootId: typeof raw.lastSeenBootId === 'string' ? raw.lastSeenBootId : '',
    accumulatedMs: typeof raw.accumulatedMs === 'number' ? raw.accumulatedMs : 0,
    platformBootId: typeof raw.platformBootId === 'string' ? raw.platformBootId : '',
    bridgeContinuity: typeof raw.bridgeContinuity === 'string' ? raw.bridgeContinuity : '',
    baseBootId: typeof raw.baseBootId === 'string' ? raw.baseBootId : (typeof raw.bootId === 'string' ? raw.bootId : ''),
    baseMono: typeof raw.baseMono === 'number' ? raw.baseMono : (typeof raw.startedMono === 'number' ? raw.startedMono : null),
    baseUptime: typeof raw.baseUptime === 'number' ? raw.baseUptime : (typeof raw.startedUptime === 'number' ? raw.startedUptime : null),
    baseWall: typeof raw.baseWall === 'number' ? raw.baseWall : raw.startedWall,
    baseBootWall: typeof raw.baseBootWall === 'number' ? raw.baseBootWall : (typeof raw.startedBootWall === 'number' ? raw.startedBootWall : null),
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
  const accumulated = typeof record.accumulatedMs === 'number' ? record.accumulatedMs : 0;

  // 同进程基准：单调时钟差。
  if (record.baseBootId === bootId && typeof record.baseMono === 'number') {
    const seg = nowMono - record.baseMono;
    if (seg < 0) return { elapsedMs: null, basis: 'unknown', continuity: 'unknown', wallJump: true };
    const elapsed = accumulated + seg;
    // 只比较「本段」的墙钟差与单调差，不能拿总累计耗时去比。
    const baseWall = typeof record.baseWall === 'number' ? record.baseWall : record.startedWall;
    const wallSeg = nowWall - baseWall;
    const wallJump = Math.abs(wallSeg - seg) > WALL_JUMP_THRESHOLD_MS;
    const bridge = typeof record.bridgeContinuity === 'string' ? record.bridgeContinuity : '';
    return {
      elapsedMs: elapsed,
      basis: 'monotonic',
      continuity: wallJump ? 'clock-changed' : (bridge !== '' ? bridge : 'continuous'),
      wallJump,
    };
  }

  // 跨 DSH 进程、同一系统启动周期：桥接到新进程启动时刻。
  const sameBoot = platformBootId !== null && record.platformBootId
    ? platformBootId === record.platformBootId
    : typeof record.baseBootWall === 'number'
      && Math.abs(nowBootWall - record.baseBootWall) <= BOOT_TOLERANCE_MS;
  if (sameBoot && typeof record.baseUptime === 'number') {
    const gap = (clock.startUptime - record.baseUptime) * 1000;
    const seg = nowMono - clock.startMono;
    if (gap >= 0 && seg >= 0) {
      const elapsed = accumulated + gap + seg;
      return {
        elapsedMs: elapsed,
        basis: 'uptime-bridge',
        continuity: 'resumed',
        wallJump: false,
      };
    }
  }

  // 系统重启：重启前累计 + 到新进程启动的空档（墙钟估算）+ 新进程内耗时。
  if (typeof record.baseWall === 'number') {
    const gap = clock.startWall - record.baseWall;
    const seg = nowMono - clock.startMono;
    if (gap >= 0 && seg >= 0) {
      const elapsed = accumulated + gap + seg;
      const wallElapsed = nowWall - record.startedWall;
      return {
        elapsedMs: elapsed,
        basis: 'restart-bridge',
        continuity: 'resumed-gap',
        wallJump: Math.abs(wallElapsed - elapsed) > WALL_JUMP_THRESHOLD_MS,
        gapEstimated: true,
      };
    }
  }

  // 无法桥接：退回整段墙钟估算，或 unknown。
  const wallElapsed = nowWall - record.startedWall;
  if (wallElapsed < 0) return { elapsedMs: null, basis: 'unknown', continuity: 'unknown', wallJump: true };
  return { elapsedMs: wallElapsed, basis: 'wall-clock', continuity: 'restarted', wallJump: false };
}

function continuityNote(continuity) {
  if (continuity === 'resumed') return 'DSH restarted during this task; elapsed was bridged with system uptime (same OS session).';
  if (continuity === 'resumed-gap') return 'the OS restarted during this task; the pre-restart and post-restart segments are measured, the shutdown gap is a wall-clock estimate.';
  if (continuity === 'restarted') return 'DSH restarted during this task; the monotonic clock did not survive, so elapsed is a wall-clock estimate.';
  if (continuity === 'clock-changed') return 'the wall clock changed during this task; elapsed uses the monotonic clock.';
  return 'clock continuity is unknown; elapsed may be unreliable.';
}

function continuityBasis(continuity) {
  if (continuity === 'continuous') return 'monotonic, host-measured';
  if (continuity === 'resumed') return 'resumed, uptime-bridged';
  if (continuity === 'resumed-gap') return 'resumed, gap estimated';
  if (continuity === 'restarted') return 'wall clock, restarted';
  if (continuity === 'clock-changed') return 'monotonic; wall clock changed';
  return 'unknown';
}

export function apply(ctx, config = {}) {
  const resolved = resolveZone(config?.timeZone || undefined);
  const zone = resolved.zone;
  const formatter = resolved.formatter;

  // 平台适配点：默认自动检测（Linux 读 boot_id，其他回退墙钟推断）。
  // 可通过插件配置 platformBootToken 手动覆盖，例如在未验证平台上自行提供启动标识。
  if (typeof config?.platformBootToken === 'string') platformBootId = config.platformBootToken;

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

  function checkpoint(record) {
    const nowWall = clock.wall();
    const nowMono = clock.mono();
    const elapsed = computeElapsed(record, nowWall, nowMono);
    if (elapsed.elapsedMs === null) return;
    const uptimeNow = clock.uptime();
    record.accumulatedMs = elapsed.elapsedMs;
    record.platformBootId = platformBootId ?? '';
    if (elapsed.continuity === 'resumed' || elapsed.continuity === 'resumed-gap') {
      record.bridgeContinuity = elapsed.continuity;
    }
    record.baseBootId = bootId;
    record.baseMono = nowMono;
    record.baseUptime = uptimeNow;
    record.baseWall = nowWall;
    record.baseBootWall = nowWall - uptimeNow * 1000;
    record.lastSeenWall = nowWall;
    record.lastSeenMono = nowMono;
    record.lastSeenUptime = uptimeNow;
    record.lastSeenBootId = bootId;
    persist();
  }

  const CHECKPOINT_MS = 10_000;
  let checkpointTimer = null;
  function startCheckpointTimer() {
    if (checkpointTimer !== null) return;
    checkpointTimer = setInterval(() => {
      for (const record of tasks.values()) {
        if (record.status === 'running') checkpoint(record);
      }
    }, CHECKPOINT_MS);
    checkpointTimer.unref?.();
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
        const note = record.continuity === 'continuous' ? '' : record.continuity === 'resumed' ? ' (resumed)' : record.continuity === 'resumed-gap' ? ' (gap estimated)' : ' (estimated)';
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
          checkpoint(running);
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
          lastSeenWall: nowWall,
          lastSeenBootId: bootId,
          accumulatedMs: 0,
          platformBootId: platformBootId ?? '',
          bridgeContinuity: '',
          baseBootId: bootId,
          baseMono: nowMono,
          baseUptime: startedUptime,
          baseWall: nowWall,
          baseBootWall: nowWall - startedUptime * 1000,
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
        checkpoint(record);
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
          checkpoint(record);
          if (elapsed.elapsedMs === null) {
            duration = 'unknown';
          } else {
            const note = elapsed.continuity === 'continuous'
              ? ''
              : elapsed.continuity === 'resumed'
                ? ' (resumed, uptime-bridged)'
                : elapsed.continuity === 'resumed-gap'
                  ? ' (resumed, gap estimated)'
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

  startCheckpointTimer();
}

export const _internals = {
  formatDuration,
  formatSignedMs,
  formatTimestamp,
  computeElapsed,
  normalizeTask,
  setBootId: (next) => { bootId = next; },
  setPlatformBootId: (next) => { platformBootId = next; },
  setClock: (next) => { clock = { ...clock, ...next }; },
};
