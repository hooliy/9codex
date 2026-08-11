import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../skills/orchestrator/SKILL.md", import.meta.url);
const skill = () => readFile(skillUrl, "utf8");

test("skill delegates durable work only through Orchestrator API", async () => {
  const text = await skill();
  for (const tool of [
    "task_group_submit",
    "task_group_status",
    "task_group_pause",
    "task_group_resume",
    "task_group_cancel",
  ]) assert.match(text, new RegExp(tool));
  assert.match(text, /后台服务.*项目经理.*事实源/s);
  assert.match(text, /禁止.*自行创建.*临时子 Agent/s);
});

test("skill preserves one user conversation as one TaskGroup and immutable demand identity", async () => {
  const text = await skill();
  assert.match(text, /thread_id.*当前用户 Codex 会话 ID/s);
  assert.match(text, /source_message_id.*重试必须复用/s);
  assert.match(text, /原始消息.*不得.*摘要覆盖/s);
  assert.match(text, /同一用户会话.*复用.*thread_id.*不得.*另一任务组/s);
  assert.match(text, /内部 Worker.*不调用.*task_group_submit/s);
});

test("skill gates risky changes on confirmation and shows impact", async () => {
  const text = await skill();
  assert.match(text, /awaiting_confirmation/);
  assert.match(text, /受影响.*新增.*取消.*重新验收.*执行顺序/s);
  assert.match(text, /公共 API.*数据结构.*数据库迁移.*生产.*付费.*不可逆/s);
});

test("skill reports only key events and requires task-group evidence before completion", async () => {
  const text = await skill();
  assert.match(text, /不要高频轮询.*心跳.*只同步/s);
  assert.match(text, /TaskGroup\.status = done/);
  assert.match(text, /finalDecision = passed/);
  assert.match(text, /最新 RequirementRevision.*全部通过/s);
  assert.match(text, /Worker 报告.*不代表任务组完成/s);
});

test("skill defines auditable hard blockers without exposing hidden reasoning", async () => {
  const text = await skill();
  assert.match(text, /阻断事实.*已尝试动作.*原始错误.*受影响范围.*最小决定/s);
  assert.match(text, /不得泄露隐藏推理/);
  assert.match(text, /可审计.*状态.*命令输出.*证据.*结论/s);
});
