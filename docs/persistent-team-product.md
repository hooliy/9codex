# 9codex 持久软件团队产品文档

状态：评审稿
版本：0.2
日期：2026-08-11

## 1. 产品结论

产品可实现，但不能继续以“模型网关附带一个编排 Skill”的方式增量扩展。

9codex 应重写为四个明确边界：

```text
Model Gateway       模型、凭据、协议转换
Task Orchestrator   需求、任务、监督、验收、恢复
Codex Adapter       创建、恢复、通信、等待、关闭内部执行会话
Taskboard           用户任务组、进度、证据、验收
```

产品定义：

> 用户主动创建的 Codex 会话是一个任务组。用户在同一会话追加的所有消息，都是这个任务组的需求、变更、反馈或验收意见。9codex 充当项目经理，自主拆分工作、创建内部执行会话、监督执行、纠偏、验收、恢复和汇总。内部执行会话是可替换的团队成员，不是用户需要管理的任务。

最终用户不再以 Codex 的项目列表和内部会话列表为主要工作入口。任务面板成为主要入口。

## 2. 可行性判断

### 2.1 总体判断

| 能力 | 可行性 | 判断 |
| --- | --- | --- |
| 用户会话映射为任务组 | 高 | 当前网关已能观察 `thread-id`、`session-id` |
| 同一会话持续追加需求 | 高 | 使用任务组事件和需求版本持久化 |
| 自动理解需求与拆分任务 | 高 | 模型负责分析，状态机负责约束 |
| 创建独立执行会话 | 中高 | 需要稳定的 Codex Adapter |
| 多任务并行开发 | 中高 | 需要 DAG、worktree、写入范围和合并队列 |
| 持续监督与自动纠偏 | 高 | 使用事件、心跳、租约、检查点 |
| 自动验收与返工 Loop | 高 | 验收必须由独立命令和证据驱动 |
| Codex 重启后恢复任务 | 高 | 任务状态必须独立持久化 |
| 完全替换 Codex 原生界面 | 中低 | 不应依赖私有 DOM/CDP 作为核心 |
| 无限时长、无限用量执行 | 不可保证 | 可保证恢复，不可保证单次执行永不中断 |

### 2.2 核心技术前提

必须提供稳定的 Codex Adapter：

```text
create
send
resume
read
wait
interrupt
archive
```

首个正式版本只能选择一个明确执行后端。禁止同时维护多套兼容逻辑。

优先顺序：

1. Codex 官方 app-server 或任务接口。
2. 官方 Codex CLI 的 `exec`、`resume` 和结构化事件。
3. 如果以上无法满足，不发布“原生会话管理”承诺。

禁止：

- 直接修改 Codex SQLite。
- 修改 rollout 历史。
- 伪造 Responses API 历史消息。
- 通过 DOM 点击模拟任务生命周期。
- 把 CDP 注入作为任务执行协议。

### 2.3 当前代码基础

当前 9codex 的产品定位仍是模型网关：

- `package.json` 将产品描述为 Codex Desktop 的 OpenAI-compatible gateway。
- `lib/gateway.mjs` 已转发 `session-id`、`thread-id`、`x-openai-subagent`，可作为任务组身份观察入口。
- `lib/control-plane.mjs` 和 `lib/daemon.mjs` 已具备授权、心跳、SSE 命令和后台服务基础。
- `lib/codex-activity.mjs` 只能判断 Codex 是否忙碌，不能管理任务生命周期。
- `skills/orchestrator/SKILL.md` 只约束单次主会话与子 Agent，无法跨重启持久执行。

结论：

```text
可复用：后台服务、控制面、SSE、命令确认、安全更新、模型网关
必须重写：编排 Skill、任务状态、会话管理、监督、验收、任务面板
必须新增：持久数据库、Codex Adapter、Scheduler、Workspace Manager
```

## 3. 产品目标

### 3.1 用户目标

用户只需要：

1. 主动创建一个会话。
2. 用自然语言提出需求。
3. 确认 Codex 对目标和完成判据的理解。
4. 持续追加需求、业务变更和反馈。
5. 查看任务组进度。
6. 接收一次性整体验收报告。

### 3.2 系统目标

9codex 必须：

- 将用户主动创建的会话识别为任务组。
- 将同一会话的后续消息归入同一任务组。
- 自动判断消息是新增需求、修正、反馈、暂停、取消还是验收。
- 维护需求版本和受影响范围。
- 自动拆分可验证的工作项。
- 根据依赖和资源冲突决定串行或并行。
- 创建独立内部执行会话。
- 监督执行会话是否存活、跑偏或阻断。
- 收集结构化执行报告和证据。
- 独立执行测试、构建和业务路径验收。
- 验收失败后自动返工。
- 验收通过后关闭内部执行会话。
- 系统重启后继续未完成任务。
- 将全部结果汇总回用户任务组。

### 3.3 产品承诺

产品承诺：

> 单个执行会话可以中断，任务组不能丢失。9codex 自动恢复、重派、验收，直到完成或遇到真实硬阻断。

产品不承诺：

- 无限 Token。
- 无限并发。
- 外部凭据缺失时仍能完成。
- 未经授权执行生产操作。
- 任意第三方服务永久可用。
- 单个 Codex 会话永不退出。

## 4. 核心产品原则

### 4.1 用户会话是唯一任务组边界

```text
用户主动新建会话 = 新任务组
用户在原会话继续消息 = 原任务组的新事件
9codex 创建内部会话 = 团队执行，不创建新任务组
```

即使用户在同一会话提出不相关需求，也只能创建新的 Requirement，不能自动创建新的 TaskGroup。

### 4.2 任务数据库是事实源

Codex 上下文不是状态源。

必须持久化：

- 需求及其版本。
- 工作项和依赖。
- 内部执行会话。
- 每次执行 Run。
- 心跳和租约。
- 文件与资源所有权。
- 执行报告。
- 测试和构建证据。
- 验收结果。
- 阻断原因。
- 下一步动作。

### 4.3 执行报告不等于完成

```text
Worker reported
≠ WorkItem passed
≠ Requirement passed
≠ TaskGroup done
```

完成必须满足：

1. 工作项完成判据通过。
2. 依赖工作项完成。
3. 集成结果通过。
4. 需求级业务路径通过。
5. 没有未处理的需求变更。

### 4.4 内部会话可替换

内部执行会话只是 Worker。

发生以下情况时可关闭并重建：

- 上下文接近上限。
- 会话状态损坏。
- 连续跑偏。
- 长时间无心跳。
- 模型不可用。
- 执行环境损坏。
- 需求版本已过期。

### 4.5 验收必须有证据

每个完成判据必须对应至少一种可审计证据：

- 文件 diff。
- Git commit。
- 测试原始输出。
- 构建原始输出。
- 静态检查结果。
- 浏览器截图。
- API 响应。
- 数据库查询。
- 用户明确确认。

## 5. 用户与系统角色

### 5.1 用户

职责：

- 提出目标。
- 确认需求理解。
- 提供无法自主取得的凭据或授权。
- 对主观体验和生产操作作最终裁决。

不负责：

- 拆分任务。
- 创建 Worker。
- 追问 Worker。
- 手动合并报告。
- 手动关闭内部会话。

### 5.2 项目经理

由 9codex Task Orchestrator 持久承担。用户主 Codex 会话只是需求输入、确认和结果展示入口；主会话关闭、损坏或上下文耗尽，不得终止项目经理职责。

职责：

- 理解和复述需求。
- 定义完成判据。
- 维护需求版本。
- 建立任务 DAG。
- 调度 Worker。
- 监督执行。
- 处理业务变更。
- 发起验收。
- 汇总交付。

### 5.3 Worker

由内部执行会话承担。

职责：

- 只处理分配的工作项。
- 遵守 worktree 和 write set。
- 定期写入检查点。
- 报告真实进度和阻断。
- 提交结构化结果。

### 5.4 Reviewer

职责：

- 不采信 Worker 自报。
- 禁止验收自己参与执行的 WorkItem。
- 检查 diff 和越界修改。
- 运行完成判据命令。
- 输出逐项结论和证据。

### 5.5 Integrator

复杂并行任务才创建。

职责：

- 按依赖顺序合并。
- 解决契约差异。
- 执行整体测试。
- 输出需求级验收证据。

## 6. 核心对象

### 6.1 TaskGroup

用户主动创建的一个 Codex 会话。

关键字段：

```text
id
origin_thread_id
title
status
workspace
current_requirement_revision
created_at
updated_at
completed_at
```

### 6.2 DemandEvent

用户消息形成的不可变原始需求事件。

关键字段：

```text
id
event_key
task_group_id
source_message_id
raw_content
classified_type
classification_confidence
received_at
processed_at
```

约束：

- `event_key` 全局唯一，重试不能重复创建事件。
- 原始消息不可被需求摘要覆盖。
- 分类和结构化结果允许重算，原始消息必须保留。
- 低置信度且会造成大范围修改时，进入 `awaiting_confirmation`。
- 用户纠正分类后保存纠正记录，不篡改历史事件。

### 6.3 Requirement

任务组中的一个业务目标。

同一任务组可以包含多个 Requirement，但不能自动拆成新的 TaskGroup。

### 6.4 RequirementRevision

每次新增需求、业务变更或验收反馈产生一个新版本。

关键字段：

```text
id
requirement_id
revision
source_message_id
normalized_requirement
acceptance_criteria
impact_summary
created_at
```

### 6.5 WorkItem

可独立执行和验收的工作单元。

关键字段：

```text
id
task_group_id
requirement_revision_id
parent_id
title
description
status
priority
dependencies
write_set
resource_locks
acceptance_criteria
version
```

### 6.6 WorkerSession

内部 Codex 执行会话。

关键字段：

```text
id
task_group_id
work_item_id
codex_thread_id
role
status
workspace
branch
worktree
context_checkpoint
last_heartbeat_at
created_at
closed_at
```

### 6.7 Run

WorkerSession 的一次执行。

```text
queued
running
reported
interrupted
failed
passed
```

### 6.8 Evidence

所有执行和验收证据。

```text
type
source
command
exit_code
output_path
artifact_path
content_hash
created_at
```

### 6.9 Acceptance

工作项、需求或任务组的验收记录。

```text
scope
criteria
result
evidence_ids
failure_reason
verified_by
created_at
```

## 7. 状态机

### 7.1 TaskGroup

```text
collecting
→ awaiting_confirmation
→ planning
→ executing
→ integrating
→ verifying
→ awaiting_user
→ done
```

补充状态：

```text
blocked
paused
canceled
```

已完成任务收到新需求：

```text
done → collecting
```

### 7.2 WorkItem

```text
backlog
→ ready
→ assigned
→ running
→ reported
→ verifying
  ├─ failed → rework → ready
  └─ passed → closed
```

补充状态：

```text
stale
blocked
canceled
```

### 7.3 WorkerSession

```text
creating
→ idle
→ running
→ waiting
→ closing
→ closed
```

异常状态：

```text
lost
corrupted
interrupted
```

### 7.4 RequirementRevision

```text
active
→ superseded
```

新版本生成后，系统必须重新计算旧 WorkItem：

```text
无影响   → 保持
需要复验 → revalidate
需要修改 → rework
已过时   → stale
```

## 8. 消息处理

每条用户消息先分类：

```text
new_requirement
requirement_change
clarification
bug_report
acceptance_feedback
priority_change
pause
resume
cancel
approval
```

处理顺序：

1. 使用 `source_message_id` 生成稳定 `event_key`。
2. 在同一事务中写入 DemandEvent；重复事件直接返回已有处理结果。
3. 读取当前任务组快照。
4. 识别消息类型并记录置信度。
5. 生成结构化需求变化。
6. 计算影响范围。
7. 建立新的 RequirementRevision。
8. 更新任务 DAG。
9. 中断或纠偏受影响 Worker。
10. 重新安排执行和验收。
11. 向用户展示变化摘要。

高影响低置信度消息不得直接执行。高影响包括：

- 删除或替换已有业务范围。
- 修改公共 API、数据结构或数据库迁移。
- 取消正在执行或已验收工作。
- 触发生产、付费或不可逆操作。

系统必须展示：

```text
识别到的变化
受影响工作项
新增工作项
取消工作项
重新验收范围
预计执行顺序
```

## 9. 任务拆分

### 9.1 拆分原则

WorkItem 必须：

- 有明确目标。
- 有明确输入。
- 有明确输出。
- 有完成判据。
- 有允许写入范围。
- 有依赖关系。
- 可以独立报告。
- 可以被主系统独立验收。

### 9.2 不拆分条件

以下情况不创建多个 Worker：

- 一行或局部修改。
- 强耦合逻辑无法独立验收。
- 多个子任务必须反复修改同一核心文件。
- 拆分成本高于执行成本。

### 9.3 并行条件

只有同时满足以下条件才并行：

- 依赖已满足。
- write set 不冲突。
- 数据库迁移不冲突。
- 端口、账号、浏览器等资源不冲突。
- API 契约已经冻结。
- 集成顺序明确。

### 9.4 冲突处理

发现两个工作项写入范围重叠：

1. 合并工作项；或
2. 增加前后依赖；或
3. 抽出公共契约工作项。

禁止先并行修改，再依赖 Git 冲突解决业务边界错误。

## 10. 自主执行 Loop

```text
读取 ready WorkItem
→ 检查依赖和资源锁
→ 创建或恢复 WorkerSession
→ 下发 handoff packet
→ 监听事件和心跳
→ 检查进度、范围和需求版本
→ 收到结构化报告
→ 独立验收
  ├─ 失败：生成失败证据，创建 rework
  ├─ 跑偏：立即中断并纠偏
  ├─ 失联：回收租约并恢复
  └─ 通过：关闭 WorkerSession
→ 全部工作项通过
→ 集成验收
→ 生成任务组交付报告
```

Loop 由 Orchestrator 状态机执行，不由提示词自行决定是否继续。

Worker 与 Reviewer 必须是不同 Run。任何执行过目标 WorkItem 的 Run 均无权为该 WorkItem 写入通过结论。

## 11. 监督机制

### 11.1 心跳

Worker 运行时定期报告：

```text
run_id
work_item_id
requirement_revision
phase
progress_summary
changed_files
current_command
next_step
blocked_reason
timestamp
```

### 11.2 租约

每个运行中 WorkItem 只有一个有效租约。

租约过期：

1. 将 WorkerSession 标记为 lost。
2. 保存最后检查点。
3. 释放资源锁。
4. 创建恢复 Run。
5. 从 handoff packet 继续。

### 11.3 跑偏判断

以下情况触发纠偏：

- 修改 write set 外文件。
- 执行目标与 WorkItem 不一致。
- 使用过期 RequirementRevision。
- 重复实现已完成工作。
- 跳过明确测试。
- 擅自改变公共契约。
- 连续报告无实际进展。

### 11.4 硬阻断

只有以下情况可要求用户介入：

- 缺少无法自主取得的凭据。
- 生产发布需要人工授权。
- 需求存在不可消除的业务歧义。
- 第三方系统持续不可用。
- 安全策略禁止执行。
- 资源额度确实耗尽。

报告必须包含：

```text
阻断事实
已尝试动作
原始错误
受影响范围
需要用户做出的最小决定
```

## 12. 上下文与恢复

### 12.1 检查点

Worker 定期保存：

```json
{
  "taskGroupId": "tg_...",
  "workItemId": "wi_...",
  "requirementRevision": 3,
  "goal": "...",
  "completedWork": [],
  "changedFiles": [],
  "commits": [],
  "testResults": [],
  "remainingWork": [],
  "knownRisks": [],
  "nextStep": "..."
}
```

### 12.2 上下文接近上限

处理方式：

1. 停止继续堆积原始历史。
2. 生成结构化检查点。
3. 保存证据和 Git 状态。
4. 关闭旧 WorkerSession。
5. 创建新 WorkerSession。
6. 注入最新需求版本、检查点和未完成判据。

### 12.3 系统重启

启动恢复流程：

1. 加载未完成 TaskGroup。
2. 将无有效心跳的 Run 标记为 interrupted。
3. 检查 worktree 和 Git 状态。
4. 恢复资源锁。
5. 重建 ready 队列。
6. 继续监督 Loop。

目标：后台服务恢复后 60 秒内重建全部未终结任务的调度状态。

## 13. Workspace 管理

每个并行 Worker 默认使用独立 worktree：

```text
<repo>/.9codex/worktrees/<task-group>/<work-item>
```

每个 WorkItem 声明：

```text
branch
worktree
write_set
read_set
resource_locks
merge_dependencies
```

合并规则：

- 通过工作项验收后才能进入 merge queue。
- 按 DAG 顺序合并。
- 每次合并后运行受影响测试。
- 合并失败重新打开对应 WorkItem。
- 整体验收前禁止删除证据。

## 14. 任务面板

### 14.1 一级页面

默认只展示用户任务组：

```text
任务组名称
当前状态
完成比例
当前阶段
运行中的团队成员数量
阻断数量
最近更新时间
```

### 14.2 任务组详情

```text
任务目标
最新需求版本
需求变更时间线
当前执行计划
任务 DAG
运行中事项
等待验收事项
已完成事项
阻断事项
测试与构建证据
最终验收报告
```

### 14.3 内部会话展示

内部 WorkerSession 默认隐藏。

高级信息可查看：

```text
角色
状态
当前工作项
上下文检查点
最近心跳
运行时长
关闭原因
```

用户不需要手动关闭 Worker。

### 14.4 主会话同步

关键事件同步回用户任务组：

- 需求确认。
- 计划生成。
- 重大范围变化。
- 真实阻断。
- 整体验收完成。

高频内部心跳不刷屏，只进入任务面板。

## 15. 最终验收

### 15.1 两级验收

内部验收：

- 每个 WorkItem 完成后自动执行。
- 失败自动返工。
- 用户不需要逐项确认。

任务组验收：

- 所有 Requirement 的最新版本完成后执行。
- 检查整体业务路径。
- 生成一次性交付报告。

### 15.2 最终报告

必须包含：

```text
任务组目标
最终需求版本
完成的需求
完成的工作项
代码变更
提交记录
测试结果
构建结果
业务路径验证
未解决风险
被取消或替代的工作
内部会话关闭情况
最终判定
```

### 15.3 重新打开

任务组完成后用户继续追加需求：

```text
done
→ collecting
→ planning
→ executing
→ verifying
→ done
```

旧交付报告保留，不覆盖历史。

## 16. 系统架构

```text
┌──────────────────────────────────────┐
│ Codex 用户任务组                    │
│ 用户消息、确认、最终交付            │
└─────────────────┬────────────────────┘
                  │ TaskGroup Event
┌─────────────────▼────────────────────┐
│ Task Orchestrator                    │
│ Requirement / DAG / Scheduler        │
│ Supervision / Verification / Recovery│
└──────┬───────────────┬───────────────┘
       │               │
┌──────▼──────┐  ┌─────▼──────────────┐
│ Codex Adapter│  │ Workspace Manager  │
│ create/send │  │ branch/worktree    │
│ wait/resume │  │ locks/merge queue  │
│ close       │  └────────────────────┘
└──────┬──────┘
       │
┌──────▼───────────────────────────────┐
│ Internal Worker Sessions             │
│ Planner / Worker / Reviewer / Integrator
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ SQLite + Artifact Store              │
│ TaskGroup / Requirement / Run / Event│
│ Evidence / Acceptance / Checkpoint   │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ Taskboard                            │
│ 用户任务组、进度、阻断、验收        │
└──────────────────────────────────────┘
```

## 17. 模块边界

### 17.1 Model Gateway

只负责：

- 模型路由。
- 凭据。
- 协议转换。
- 请求规范化。
- 模型能力。

允许向 Orchestrator 发布只读身份事件：

```text
thread_observed
request_started
request_completed
```

禁止直接修改任务状态。

### 17.2 Task Orchestrator

负责：

- 任务组。
- 需求版本。
- WorkItem DAG。
- Scheduler。
- WorkerSession 生命周期。
- 验收。
- 恢复。
- 审计。

### 17.3 Codex Adapter

负责把统一操作转换为 Codex 能力：

```text
createWorker
sendInstruction
readEvents
waitWorker
interruptWorker
resumeWorker
closeWorker
```

Orchestrator 不得直接依赖 Codex 内部 SQLite 或 rollout 格式。

### 17.4 Workspace Manager

负责：

- worktree 创建和回收。
- Git 状态检查。
- 文件写入范围。
- 资源锁。
- merge queue。
- 集成失败恢复。

### 17.5 Taskboard

只读取 Orchestrator API，不读取 Codex 内部数据。

## 18. 持久化

MVP 使用本地 SQLite：

```text
~/.9codex/team.sqlite
```

附件和大输出：

```text
~/.9codex/artifacts/
```

建议表：

```text
task_groups
conversation_bindings
demand_events
requirements
requirement_revisions
work_items
work_item_dependencies
worker_sessions
runs
events
checkpoints
resource_locks
evidence
acceptances
artifacts
outbox
```

数据库要求：

- WAL。
- foreign keys。
- busy timeout。
- version 乐观锁。
- 每个 WorkItem 只允许一个有效租约。
- 每个 WorkerSession 只允许一个 running Run。
- 任务状态变化必须写事件日志。
- 状态变更和 outbox 事件必须在同一事务提交。
- 数据库启动前执行版本迁移；迁移失败不得启动 Orchestrator。
- 每次迁移前生成可恢复备份。
- 定期备份数据库和事件日志，并执行恢复演练。

## 19. 安全与审计

必须：

- 服务默认只监听 loopback。
- 本地 API 使用随机令牌。
- Artifact 使用用户私有权限。
- 日志过滤凭据。
- Worker 权限按任务最小化。
- 生产操作必须显式授权。
- 所有状态变化记录 actor、时间和来源。
- 删除内部会话前保存最终检查点。

不得：

- 将 API Key 写入任务上下文。
- 将完整凭据同步给 Worker。
- 让远程控制面发送任意 shell。
- 自动执行不可逆生产操作。
- 因任务面板需要而关闭 Codex renderer CSP。

## 20. MVP

### 20.1 MVP 范围

第一版只实现：

1. 用户会话映射 TaskGroup。
2. 同会话消息形成 RequirementRevision。
3. 主会话确认需求和完成判据。
4. 自动生成 WorkItem DAG。
5. 创建独立 WorkerSession。
6. 最多并行三个无冲突 WorkItem。
7. Worker 心跳、检查点和结构化报告。
8. 自动运行命令级验收。
9. 验收失败自动返工。
10. 验收通过关闭 Worker。
11. 重启后恢复未完成任务。
12. 本地 Web Taskboard。
13. 最终一次性交付报告。
14. 暂停、恢复、取消任务组。
15. DemandEvent 幂等处理和原始消息追溯。
16. SQLite 迁移、备份和恢复。

### 20.2 MVP 不做

- 云端多人协作。
- 手机端。
- 跨设备任务迁移。
- 可视化流程编辑器。
- 自定义 Agent 市场。
- 基于私有 DOM 的 Codex 深度 UI 注入。
- 自动生产发布。
- 无限并发。
- 自动决定高风险业务取舍。

## 21. 实施阶段

### Phase 0：验证 Codex Adapter

目标：

- 验证创建、发送、等待、恢复、关闭内部执行会话。
- 验证结构化事件。
- 验证 Codex 重启后的恢复行为。

发布门槛：

- 七个 Adapter 操作全部可自动测试。
- 不修改 Codex 数据库和历史记录。
- 无稳定 Adapter 时停止后续开发。

### Phase 1：持久任务内核

新增：

```text
Orchestrator DB
TaskGroup
RequirementRevision
WorkItem DAG
Run/Event
Lease/Heartbeat
Recovery
```

重写现有 orchestrator Skill，使其只调用 Orchestrator API。

### Phase 2：单 Worker 闭环

新增：

```text
Scheduler
WorkerSession Manager
Workspace Manager
Checkpoint
Rework Loop
```

发布门槛：

- 一个 Worker 可完成“执行、报告、独立验收、返工、关闭”完整闭环。
- Worker 或 Codex 中断后可由新 Worker 接替。
- TaskGroup 不依赖任何单一会话继续存在。

### Phase 3：验收系统

新增：

```text
Verification Runner
Evidence Store
Integration Queue
Final Acceptance
```

### Phase 4：安全并行

在单 Worker 闭环稳定后新增：

```text
writeSet
resourceSet
独立 worktree
依赖调度
merge queue
Integrator
```

### Phase 5：任务面板

新增独立本地 Taskboard：

```text
任务组列表
需求时间线
任务 DAG
运行状态
阻断
证据
最终报告
```

### Phase 6：可选 Codex UI Bridge

仅在存在稳定官方扩展入口时实现。

不得影响 Task Orchestrator、Worker 或数据库运行。

## 22. 产品验收标准

### 22.1 任务组

- 用户创建新会话后生成且只生成一个 TaskGroup。
- 同一用户会话的后续消息不生成新 TaskGroup。
- 内部 WorkerSession 永不出现在任务组一级列表。
- 用户可暂停、恢复、取消任务组。

### 22.2 需求变更

- 每次业务变更生成 RequirementRevision。
- 系统展示受影响 WorkItem。
- 使用旧版本需求的 Worker 被纠偏、复验或关闭。

### 22.3 并行执行

- 无冲突工作项可并行。
- write set 重叠工作项不能同时运行。
- 每个 Worker 使用独立 worktree。
- 并发 Worker 上限生效。

### 22.4 监督

- Worker 失去心跳后自动标记 lost。
- 租约过期后任务重新进入 ready。
- 跑偏修改能被检测并阻止进入验收。
- 主任务停止后，任务状态仍可恢复。

### 22.5 验收

- Worker 自报完成不会直接关闭 WorkItem。
- 每条完成判据都有 Evidence。
- 验收失败自动生成 rework。
- 全部需求通过前 TaskGroup 不能进入 done。

### 22.6 恢复

- 强制终止 9codex 后重启，未完成任务可继续。
- 强制终止 Worker 后，WorkItem 可由新 Worker 恢复。
- 上下文接近上限时，新 Worker 能从检查点继续。
- 已保存证据不会因 Worker 退出丢失。
- 服务恢复后 60 秒内恢复调度。
- 数据库迁移失败可从备份恢复，不能产生半迁移状态。

### 22.7 用户体验

- 用户无需打开内部会话即可完成任务。
- 用户只收到需求确认、真实阻断和最终交付等关键消息。
- Taskboard 能解释当前在做什么、为什么阻断、如何验收。
- Taskboard 状态变化 5 秒内可见。

## 23. 产品指标

核心指标：

```text
TaskGroup 完成率
需求变更正确传播率
Worker 自动恢复成功率
验收失败自动返工成功率
并行任务冲突率
错误完成率
用户人工追问次数
任务重启恢复时间
```

首版目标：

- 任务状态恢复成功率：100%。
- Worker 中断恢复成功率：≥95%。
- 无 write set 的越界合并：0。
- 无证据完成：0。
- 内部 Worker 需要用户手动回收：0。
- 用户任务组重复创建：0。
- 需求事件重复处理：0。
- 进程恢复后重建调度：≤60 秒。
- Taskboard 状态延迟：≤5 秒。

## 24. 主要风险

### 24.1 Codex 会话接口不稳定

风险：无法可靠创建、等待、恢复和关闭会话。

处理：Phase 0 先验证。失败则不进入正式开发。

### 24.2 需求理解错误

风险：系统拆分了错误任务并自主执行。

处理：首次需求和重大范围变化必须先确认；小范围修正可自动执行并展示变更摘要。

### 24.3 并行修改冲突

风险：多个 Worker 修改同一公共文件或契约。

处理：write set、资源锁、公共契约任务、独立 worktree、merge queue。

### 24.4 验收被模型自报替代

风险：Worker 声称测试通过，实际未运行。

处理：命令由 Orchestrator Verification Runner 执行并保存原始输出。

### 24.5 长任务无限循环

风险：同一失败反复返工，持续消耗额度。

处理：

- 相同失败指纹达到阈值后标记 blocked。
- 保存全部尝试证据。
- 只请求用户做最小裁决。

### 24.6 UI 注入失效

风险：Codex 更新导致任务面板入口失效。

处理：Taskboard 独立运行；UI Bridge 只是可选入口。

### 24.7 隐私与凭据泄露

风险：需求、代码、日志或 API Key 被传给不需要的 Worker。

处理：最小上下文包、凭据引用、日志脱敏、本地优先存储。

## 25. 决策

### 25.1 通过

以下方向确认可实施：

- 用户会话即任务组。
- 同会话持续追加需求。
- 9codex 作为项目经理。
- 内部执行会话组成持久团队。
- 自动拆分、并行、监督、纠偏和验收。
- 本地持久任务面板。
- 一次性任务组验收。

### 25.2 条件通过

“直接管理 Codex 新会话”必须先通过 Codex Adapter 技术验证。

### 25.3 拒绝

以下方案不采用：

- 继续只依赖 orchestrator Skill。
- 把普通子 Agent 当作长期团队。
- 修改 Codex 本地历史实现恢复。
- 把 Taskboard 状态混入模型请求协议。
- 依赖 CDP/DOM 实现核心任务生命周期。
- 承诺无限执行时间或无限用量。

### 25.4 最终产品定位

> 9codex 是建立在 Codex 之上的持久软件团队系统。用户通过一个任务组持续表达目标和变化；9codex 负责理解、规划、派工、监督、恢复、验收和交付。内部会话可以结束，团队工作不能中断。
