---
name: demand-intake
description: 将用户持续输入的一段文字、附件、明确文件路径、Word/PDF/表格/图片、网页 URL、钉钉任务或其他明确来源读取为核心兼容的 Demand Proposal，批量提取需求，保留来源引用与指纹，先向用户复述确认，再提交给 9codex。用户提出新需求、需求变更、Bug、验收反馈、计划、PRD、会议纪要、任务清单或要求从材料中拆需求时默认使用；即使用户没有说“需求分析”或“demand intake”也应触发。
---

# 通用需求接入

把任意**明确来源**转换成可确认、可审计、可执行的需求提案。输入读取属于本 Skill；持久调度、执行、验收属于 9codex。

```text
明确来源
→ 选择现有 Skill / 工具读取
→ 建立 source 证据
→ 生成核心兼容 Demand Proposal
→ 向用户复述
→ 等待明确确认
→ 独立传入 content、source、proposal
→ TeamStore Requirement Revision 成为执行事实
```

## 来源边界

只读取用户在当前请求或当前会话中明确给出的来源：

- 用户消息中的原始文字。
- 当前消息附带的附件。
- 用户给出的准确绝对路径。
- 用户给出的明确 URL。
- 用户明确指定的钉钉任务、文档、表格或记录。
- 用户明确要求沿用的当前会话既有材料。

禁止：

- 扫描整机、用户目录、下载目录、最近文件或其它目录寻找可能来源。
- 猜测“我的计划”“那个文档”“之前的表格”具体指什么。
- 用名称相似、时间最近或历史材料替代本次来源。
- 来源不存在、不可读、权限不足或内容不完整时虚构内容。
- 读取与需求提取无关的附件、链接、账号数据或文件。

来源不明确时停止读取，只询问一个能定位来源的最小问题：请求文字、附件、准确路径、URL 或钉钉记录定位信息。

## 按来源选择能力

优先使用已存在、最窄、只读的 Skill 或工具：

| 来源 | 读取方式 |
|---|---|
| 当前消息文字 | 直接读取，不调用额外工具 |
| 本地纯文本、Markdown、JSON、代码 | 文件读取工具 |
| Word / DOCX | `documents` Skill |
| PDF | `pdf` Skill |
| Excel / CSV / TSV | `spreadsheets` Skill |
| 图片、截图 | 当前视觉能力；需要 OCR 时使用已有图像读取能力 |
| 网页 URL | `browser` 或网页读取工具 |
| 钉钉任务、文档、表格 | `dws` Skill |
| 其它外部系统 | 当前环境已提供、用户已授权的对应连接器 |

不得为“可能用到”安装依赖、创建连接器、绕过登录、权限或验证码。读取失败时报告原始错误和未读取范围。

## 核心 source 合同

`task_group_submit` 使用一个独立顶层 `source` 参数：

```json
{
  "kind": "message|attachment|path|document|image|url|dingtalk|bundle|external",
  "reference": "用户可识别的消息、附件、绝对路径、URL、外部记录 ID 或来源包引用",
  "fingerprint": "sha256:<实际读取内容或来源包清单的 SHA-256>",
  "metadata": {
    "version": null,
    "readAt": "ISO-8601 时间",
    "scope": "实际读取的页码、工作表、记录或内容范围",
    "items": []
  }
}
```

单一材料直接记录。多个材料组成一个 `kind: "bundle"` 的来源包；逐项证据写入 `metadata.items`，每项记录 `kind`、`reference`、`fingerprint`、`version`、`scope`。

指纹规则：

- 原始文字：对实际 UTF-8 文字计算 SHA-256。
- 本地文件和附件：对实际读取的文件字节计算 SHA-256。
- 网页：保留 URL，对本次实际提取的正文计算 SHA-256。
- 钉钉或其它外部记录：保留稳定记录 ID、版本或更新时间，对实际读取内容计算 SHA-256。
- 来源包：对稳定排序后的 `metadata.items` 清单计算顶层 SHA-256。
- 无法计算指纹时阻断，不得伪造、留空或继续提交。

外部材料不复制进 Proposal。敏感信息只保留必要引用；凭据、Cookie、Token、密钥不得进入 `source`、Proposal 或提交内容。

## 核心 Demand Proposal 合同

Proposal 必须精确匹配 `/Users/cc/9codex/lib/demand-intake.mjs` 的 camelCase 合同：

```json
{
  "summary": "本次需求批次的整体目标",
  "questions": [],
  "requirements": [
    {
      "key": "本提案内唯一稳定键",
      "requirementId": null,
      "title": "可交付结果",
      "normalizedRequirement": "完整、无歧义、可执行的需求",
      "impactSummary": "相对当前 Revision 的新增或变化摘要",
      "acceptanceCriteria": [
        {
          "id": "acceptance-1",
          "command": ["npm", "test"]
        }
      ],
      "impactActions": [],
      "workItems": [
        {
          "key": "work-1",
          "title": "最小可独立验收工作项",
          "description": "执行范围与预期结果",
          "priority": 0,
          "writeSet": ["src/example.mjs"],
          "readSet": [],
          "resourceLocks": [],
          "dependencies": [],
          "acceptanceCriteria": [
            {
              "id": "work-acceptance-1",
              "command": ["node", "--test", "test/example.test.mjs"]
            }
          ]
        }
      ]
    }
  ]
}
```

合同规则：

- `summary`、`questions`、`requirements` 位于 Proposal 顶层。
- 一个输入可产生多个 `requirements`；每个独立交付结果建立一项。
- `requirements` 至少一项；每个 `key` 在本提案内唯一。
- 新需求使用 `requirementId: null`；变更必须绑定现有 `requirementId`，禁止按标题猜测或静默覆盖。
- `normalizedRequirement` 保存用户确认后的完整要求，不得使用标题或摘要替代。
- `acceptanceCriteria[].command` 必须是非空 argv 数组，禁止 shell 字符串。
- `workItems` 至少一项；每个工作项 `key` 在所属 Requirement 内唯一。
- `writeSet`、`readSet`、`resourceLocks`、`dependencies` 使用数组；`priority` 使用整数。
- `impactSummary` 说明新增、修改、删除、影响范围及重新验收原因。
- `impactActions` 是封闭对象数组；每项必须包含现有 `workItemId` 与 `action`，`action` 只允许 `rework`、`revalidate`、`stale`、`canceled`。
- 缺失信息写入顶层 `questions`。影响交付定义、工作区或验收方式的问题未解决时，不进入确认。
- 批量材料在同一 Proposal 的 `requirements` 中拆分；来源证据只放独立 `source` 参数。
- 重复内容只标记为候选重复，不静默合并。

Proposal 已包含最小 WorkItem DAG。提交时必须原样传入 `proposal`，让核心直接规范化并使用；不得省略后再次触发 Planner 生成另一份计划。

## 复述与确认

读取完成后先向用户展示：

```text
整体目标与 summary
requirements 列表
每项 normalizedRequirement
范围与不包含范围
acceptanceCriteria
workItems、dependencies、优先级
impactSummary 与 impactActions
未解决 questions
source.reference 与 source.fingerprint
准备提交的执行范围
```

然后明确请求用户确认或修正。

**用户未明确确认当前完整 Proposal 与来源指纹前，不得调用 `task_group_submit`，不得创建执行任务，不得把外部材料标记为已确认需求。**

“继续看看”“先分析”“大概可以”不算确认。用户修正后生成新提案版本并再次复述；旧提案保留为历史证据。

## 提交 9codex

用户明确确认后，将原始需求、来源证据、结构化提案作为独立参数调用：

```js
task_group_submit({
  content: "用户原始需求文字；不得拼接 Proposal 或 source",
  workspace: "/用户明确确认的绝对路径",
  title: "已确认的简短交付标题",
  source: {
    kind: "message|attachment|path|document|image|url|dingtalk|bundle|external",
    reference: "原始来源引用",
    fingerprint: "sha256:...",
    metadata: {}
  },
  proposal: {
    summary: "...",
    questions: [],
    requirements: []
  }
})
```

`content`、`source`、`proposal` 是独立的 `task_group_submit` 参数：

- `content` 只保存不可变的用户原始需求文字；不嵌入 Proposal，不嵌入来源对象，不用摘要覆盖。
- `source` 只保存原始来源引用、指纹和元数据。
- `proposal` 只保存用户已确认、符合核心合同的结构化计划。

始终传入已确认的 `proposal`。不得只提交 `content` 让核心 Planner 重复拆分。复用当前 Codex 会话绑定；同一会话的新需求、变更、Bug 和验收反馈继续进入同一 TaskGroup。后续状态控制交给 `orchestrator` Skill。

如果返回 `awaiting_confirmation`，展示 9codex 识别出的执行影响并再次等待确认；不得自行批准。

## 事实源与新版本

外部文字、文件、网页、钉钉记录和计划始终只是**来源证据**。用户确认并成功提交后，TeamStore 当前激活的 `Requirement Revision` 才是执行事实。

再次读取同一来源或收到新版本时：

1. 比较 `source.reference`、版本和 `source.fingerprint`。
2. 对照当前 `Requirement Revision`。
3. 生成新的 Demand Proposal。
4. 现有需求绑定 `requirementId`。
5. 使用 `impactSummary` 描述新增、修改、删除及影响范围。
6. 使用 `impactActions` 标记 `rework`、`revalidate`、`stale`、`canceled`。
7. 展示受影响任务和重新验收范围，等待用户确认。
8. 确认后独立提交新的 `source` 与 `proposal`，创建新的 TeamStore `Requirement Revision`。

禁止静默覆盖、原地改写或删除历史提案、来源证据及 `Requirement Revision`。来源内容变化但业务要求未变化时，也要生成新提案并在 `impactSummary` 中说明无业务变化。

## 完成边界

本 Skill 完成于：

```text
Demand Proposal 已确认
+ task_group_submit 已成功接收
+ source 与 proposal 已作为独立参数提交
```

不得把“材料读取完成”“提案生成完成”或“提交成功”称为需求执行完成。执行完成只能由 9codex 的任务组验收状态判定。
