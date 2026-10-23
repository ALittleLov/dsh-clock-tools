# DSH Clock Tools

**A task-timing plugin for DSH local AI agents.**

为 DSH 本地 AI Agent 提供可核实的任务计时能力，把预计耗时、实际耗时和任务状态分开管理。

> **项目状态**：0.1.2 已发布到 GitHub（[仓库](https://github.com/ALittleLov/dsh-clock-tools) · [Releases](https://github.com/ALittleLov/dsh-clock-tools/releases)）。
>
> **已验证环境**：DSH 0.2.1-rc.2（仅此版本实测；其他版本未验证）。

## 为什么需要这个项目？

AI Agent 能理解“5 分钟”“20 分钟”“超时”这些词，但这不代表它知道现实中已经过去了多久。

典型问题：Agent 预计任务要 20 分钟，实际不到 2 分钟就做完，之后却把“预计 20 分钟”说成“已经过了 20 分钟”。

这暴露的是系统设计问题，不是模型态度问题：

- 预计耗时是预测，不是测量。
- 距上一条消息的间隔，不等于任务执行时间。
- 当前日期时间，不等于持续运行期间的经过时间。
- 任务跨 turn 后，需要能保留和查询之前的计时记录。

DSH 自带的时间上下文能提供当前时间，但任务级计时需要另一套机制。这个插件的做法是：**宿主程序负责计时，Agent 负责在合适的时候调用工具并解释结果。**

## 功能

### 1. 任务计时

`task_clock` 工具提供五个动作：

| 操作 | 用途 |
|---|---|
| `start` | 创建任务计时，记录预计耗时与单调时钟起点 |
| `check` | 查询当前实际耗时、预计耗时与剩余时间 |
| `finish` | 结束计时，记录实际耗时、偏差与状态 |
| `list` | 查询已保存的任务记录 |
| `now` | 查询当前本地时间与时区（不创建任务；需要报时刻时用它，不要推算） |

参数（完整定义以包内 `index.js` 为准）：

| 参数 | 必填 | 说明 |
|---|---|---|
| `action` | 是 | `start` / `check` / `finish` / `list` / `now` |
| `taskId` | 否 | 指定任务；`check` / `finish` 默认当前 session 的 running 任务 |
| `plannedSeconds` | 否 | 预计耗时，单位秒（`start`） |
| `label` | 否 | 任务标签（`start`） |
| `outcome` | 否 | `completed` / `aborted`，默认 `completed`（`finish`） |
| `limit` | 否 | `list` 条数，默认 10，最大 50 |
| `allSessions` | 否 | `list` 是否包含其他 session 的记录 |

返回值为一段人类可读文本（`text`），不是结构化 JSON 字段。

### 2. 使用单调时钟测量经过时间

同一进程内，实际耗时用 `performance.now()` 的差值计算。墙钟（`Date.now()`）只用于显示开始/结束时间，以及跨进程时的估算。

这样，普通的系统日期时间调整不会直接改变进程内连续运行的耗时结果。

### 3. 区分预计与实际

任务记录分开保存：

- `plannedMs`：预计耗时
- `actualMs`：实际耗时
- `status`：`running` / `completed` / `aborted` / `uncertain`

偏差：

```
Variance = actualMs - plannedMs
```

负数表示比预计早完成，正数表示超时。

显示时长按整秒向下取整；内部仍保留毫秒。精确核对请看 `tasks.json` 的原始值，不要拿格式化后的文本反推。

### 4. 任务记录持久化

记录写入 `~/.dsh/clock-context/tasks.json`（JSON 数组，原子替换）。

- 跨 turn：普通新消息不会清空记录，后续 `list` 能查到。
- 跨 session：默认 `list` 只看当前 session；`allSessions: true` 可看同一文件里的全部记录。
- 跨进程重启：单调时钟起点不能延续，见下一节。

### 5. 多种 preset 支持

验证口径（DSH 0.2.1-rc.2）：

- **0.1.0 的四个动作**（`start` / `check` / `finish` / `list`）：Standard / Cordis / Minimal / PTC 四种 preset 均完成真实会话验证。
- **0.1.1 新增的 `now`**：目前只在 **Standard** 会话实测通过；Cordis / Minimal / PTC 未单独验证 `now` 动作。

| preset | 四动作（0.1.0） | `now`（0.1.1） |
|---|---|---|
| Standard | ✅ | ✅ |
| Cordis | ✅ | 未单独验证 |
| Minimal | ✅ | 未单独验证 |
| PTC | ✅（`run_code` / `ptc-dispatch`） | 未单独验证 |

插件在 Profile 层注册，不依赖 preset。但这不代表所有 DSH 版本、所有 Profile 或所有平台都已验证。

## 工作原理

1. Agent 判断任务是否需要计时。
2. 调用 `task_clock.start`，记录任务标识、预计耗时、墙钟与单调时钟起点。
3. 执行过程中可调用 `task_clock.check` 查询实际经过时间。
4. 任务完成后调用 `task_clock.finish`。
5. 记录写入本地文件，后续可用 `task_clock.list` 查询。

插件**不会**因为存在计时能力就自动给所有任务计时；是否在合适的时机调用，是 Agent 的行为问题，不是插件的保证。

## 时钟连续性与重启

| 情况 | 行为 |
|---|---|
| 连续运行（同一进程） | 单调时钟差值，`continuity: continuous` |
| 墙钟发生跳变 | `continuity: clock-changed`，仍用单调时钟，标注墙钟变化 |
| 进程重启 | `continuity: restarted`，用墙钟估算并注明“process restarted” |
| 墙钟回退、无法估算 | `actualMs: null`，状态 `uncertain`，不编造耗时 |

跨重启的结果只是估算，不能等同于连续运行时的单调时钟结果。插件也不声称能抵御所有系统级计时篡改。

## 安装

- **支持版本**：DSH 0.2.1-rc.2（仅此版本实测）
- **安装范围**：Profile 级（同一 Profile 下的所有 preset 共享；其他 Profile 需分别安装）
- **安装后重启**：需要，完全退出 DSH 再启动

### GUI（已验证）

1. 侧边栏打开 **Plugins（插件）**
2. 点 **Add plugin（添加插件）**
3. 解压发行 ZIP，输入解压出来的 `dsh-clock-tools` 目录的绝对路径（选择目录，不是 ZIP 文件本身）
4. 安装 → **Enable now（立即启用）**
5. 完全退出 DSH，再启动

装完后插件页面会显示标题与描述，新会话工具列表出现 `task_clock`。

### CLI（命令来自 DSH 支持的方式，本包未实测）

```sh
dsh plugin --profile <你的 Profile> add "<本地目录绝对路径>"
```

### 升级

当前发行包未提供升级命令；升级时建议卸载后重新安装（未实测）。

### 卸载

GUI：插件页面 → 对应插件 → Remove（入口存在，卸载流程本身未实测）。

CLI（未实测）：

```sh
dsh plugin --profile <你的 Profile> remove dsh-clock-tools
```

任务记录不会被删除；需要清理时手动删除 `~/.dsh/clock-context/`。

## 使用

```
task_clock start   plannedSeconds=1200  label="写报告"
task_clock check
task_clock finish  outcome=completed
task_clock list
task_clock now
```

`now` 返回示例：

```
Now: 2026-10-23T20:33:01+08:00[Asia/Shanghai]
```

如果当前有 running 任务，会多一行：

```
Now: 2026-10-23T20:33:01+08:00[Asia/Shanghai]
Running task t-abc123: 1m 58s elapsed
```

返回示例（数字仅用于说明输出格式，不代表同一次真实测试；精确值以 `tasks.json` 里的毫秒字段为准）：

```
Task t-abc123 (写报告): running
Started: 2026-10-23T18:29:00+08:00[Asia/Shanghai]
Elapsed: 1m 58s (monotonic, host-measured)
Planned: 20m 0s; remaining: 18m 2s
```

```
Task t-abc123 (写报告): completed
Started: 2026-10-23T18:29:00+08:00[Asia/Shanghai]
Ended: 2026-10-23T18:30:58+08:00[Asia/Shanghai]
Actual: 1m 58s (monotonic, host-measured)
Planned: 20m 0s
Variance: -18m 2s
```

注意：如果 Agent 没有 `start`，就没有有效起点；不能在任务结束后凭回忆补造耗时。

## Token 与系统开销

- 不轮询、不每秒调用模型、不持续注入时间消息。
- 但工具 Schema 会进入每个模型请求的工具列表：**估算约 300 tokens / 请求**（未实测）。
- 子 Agent 默认不注册，可用配置项 `includeSubagents: true` 打开。
- 没有真实 Token usage 测量，因此不给出“节省比例”。
- CPU / 内存 / 磁盘开销未测量；设计上每次调用 O(1)，持久化会重写整个 `tasks.json`（任务越多文件越大）。

## 隐私与数据

经代码核对：

- **无网络请求**：只使用 Node 内置模块（`fs` / `path` / `os` / `crypto`）与 `Intl`，没有 `fetch`、HTTP 客户端或遥测。
- 任务记录路径：`~/.dsh/clock-context/tasks.json`。
- 记录字段包含：`taskId`、`sessionId`、`label`（用户/模型提供的标签，会写入文件）、`plannedMs`、`startedWall`、`startedMono`、`bootId`、`endedWall`、`endedMono`、`actualMs`、`wallJump`、`continuity`、`createdAt`。
- 数据不自动过期；卸载插件不会删除记录。
- 删除方法：完全退出 DSH 后删除 `~/.dsh/clock-context/` 目录。

## 已知限制

1. Agent 必须主动调用计时工具；插件不会自动开始或结束计时。
2. 预计耗时是预测，不是测量。
3. 单调时钟不能跨进程重启延续。
4. 重启后的墙钟估算结果必须标记不确定性。
5. 显示值为整秒向下取整，不等于内部毫秒精度。
6. 四种 preset 的验证不等于所有 DSH 版本、所有 Profile、所有平台均已验证。
7. 工具 Schema 会增加模型输入 Token（估算值，未实测）。
8. 没有自动超时中止功能。
9. `now` 读的是本机系统时钟；如果系统时间本身被调错，它也会给出错误时刻——它解决的是“不要自己估算”，不是“校准时间”。

## 测试

- 单元测试：7 个（时长格式化、投影/状态边界、任务流程、墙钟跳变、进程重启、墙钟回退、无记录时 list）。
- 发行包解压后从目录加载：`SMOKE_OK`。
- 四种 preset 真实会话：Standard / Cordis / Minimal / PTC 均完成 start → check → finish → list。

未测试：其他 DSH 版本、其他 Profile、macOS / Linux、npm/GitHub 安装链路、Tool Schema 的真实 Token 用量。

## 版本与发布信息

- **当前版本**：0.1.2
- **支持 DSH**：0.2.1-rc.2（实测）
- **许可证**：MIT（见 `LICENSE`）
- **问题反馈 / 更新日志**：GitHub Issues 与 Releases（见仓库链接）。

## 项目理念

这个项目不是想让 AI 假装自己有一块永不出错的秒表。

它只是把任务计时交给程序，把可核实的时间数据交给 Agent，让判断有依据，而不是只靠语言上的自信。
