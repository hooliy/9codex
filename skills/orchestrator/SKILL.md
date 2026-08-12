---
name: orchestrator
description: 将当前 Codex 用户会话中的软件任务提交给 9codex 持久 Task Orchestrator，并查询、暂停、恢复或取消任务组。非简单、多步骤、多模块、跨会话或需要独立验收的工作默认使用。
---

# 9codex 持久任务组

9codex 后台服务是项目经理和状态事实源。本 Skill 只负责把用户需求、变更和反馈提交给 Orchestrator API，并向用户展示关键状态。

禁止在本 Skill 内：

- 自行创建或管理临时子 Agent。
- 使用 `create_thread`、`codex exec`、DOM、CDP 或 Codex SQLite 实现团队生命周期。
- 将 Worker 自报当作完成。
- 将 API Key、Authorization 或完整凭据写入需求。

## 提交需求

以下工作默认调用 `task_group_submit`：

- 非简单、可拆分、多步骤或多模块任务。
- 需要跨 Codex 重启继续的任务。
- 需要并行、监督、返工、证据或独立验收的任务。
- 用户在当前会话追加的需求、业务变更、Bug、优先级变化或验收反馈。

参数：

```text
thread_id           可选；当前用户 Codex 会话 ID
source_message_id   可选；当前用户请求 ID；重试必须复用
content             用户原始消息；不得用摘要覆盖
workspace           当前代码仓库绝对路径
title               可选任务组标题
```

通常省略 `thread_id` 和 `source_message_id`，后台从当前唯一活动的 Codex
请求安全绑定。并发会话导致 `active_conversation_ambiguous` 时，从当前环境
读取 `CODEX_THREAD_ID`，作为 `thread_id` 重试；`source_message_id` 可继续
省略，MCP 使用稳定工具调用标识生成幂等事件 ID。同一用户会话始终复用同一
`thread_id`。不得为同一会话的新需求创建另一任务组。内部 Worker 不调用
`task_group_submit`。

首次需求或高影响低置信度变更返回 `awaiting_confirmation` 时：

1. 展示系统识别的变化。
2. 展示受影响、新增、取消、重新验收范围和执行顺序。
3. 等待用户确认。
4. 将确认作为新的原始消息再次调用 `task_group_submit`。

高影响包括公共 API、数据结构、数据库迁移、生产、付费、取消已验收工作和不可逆操作。

## 状态与控制

- `task_group_status`：显示需求版本、DAG、运行项、阻断、证据、验收；默认隐藏内部 Worker，诊断时使用 `advanced=true`。
- `task_group_pause`：用户要求暂停时调用。
- `task_group_resume`：用户要求继续时调用。
- `task_group_cancel`：用户明确取消时调用；不可替代暂停。

不要高频轮询或把心跳刷给用户。只同步：

- 需求确认。
- 计划生成。
- 重大范围变化。
- 真实硬阻断。
- 整体验收完成。

## 完成判断

只有 `task_group_status` 显示：

```text
TaskGroup.status = done
finalDecision = passed
最新 RequirementRevision 全部通过
全部要求的 Evidence 存在
```

才可向用户宣布完成。

Worker 报告、单个测试通过、单个 WorkItem 关闭均不代表任务组完成。

真实硬阻断必须展示：

```text
阻断事实
已尝试动作
原始错误
受影响范围
需要用户做出的最小决定
```

不得泄露隐藏推理。只展示可审计的状态、命令输出、证据和结论。
