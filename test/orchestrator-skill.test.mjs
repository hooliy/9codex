import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../skills/orchestrator/SKILL.md", import.meta.url);

async function skill() {
  return readFile(skillUrl, "utf8");
}

test("orchestrator 默认编排非简单且可拆分的任务，但不滥拆简单或强耦合任务", async () => {
  const text = await skill();

  assert.match(text, /非简单.*可拆分.*多步骤.*多模块.*默认触发/s);
  assert.match(text, /简单.*一行.*强耦合.*串行.*不.*拆/s);
});

test("主会话确认需求、定义完成判据并按无冲突边界拆分", async () => {
  const text = await skill();

  assert.match(text, /理解.*复述.*用户确认/s);
  assert.match(text, /完成判据.*可执行.*可验证/s);
  assert.match(text, /业务边界.*文件.*资源.*不冲突/s);
});

test("支持 delegate_task 一次性受监督生命周期", async () => {
  const text = await skill();

  assert.match(text, /两种受监督模式/s);
  assert.match(
    text,
    /delegate_task.*等价.*一次性子 Agent.*父任务.*完成通知.*自动结束.*不可.*close_agent/s,
  );
  assert.match(text, /一次性.*验收失败.*失败证据.*新派.*修正 Agent/s);
});

test("支持 multi_agent_v1 可续聊受监督生命周期", async () => {
  const text = await skill();

  for (const tool of [
    "multi_agent_v1.spawn_agent",
    "wait_agent",
    "send_input",
    "close_agent",
  ]) {
    assert.match(text, new RegExp(tool.replaceAll(".", "\\.")));
  }
  assert.match(text, /可续聊.*优先.*send_input.*验收通过.*close_agent/s);
  assert.match(text, /工具名不同.*按.*两种模式.*等价.*语义/s);
  assert.match(text, /禁止.*create_thread.*codex exec.*受监督子 Agent.*替代/s);
});

test("主会话不采信自报，亲自执行完整验收", async () => {
  const text = await skill();

  assert.match(text, /不采信.*自报/s);
  assert.match(text, /主会话.*亲自.*文件.*diff.*测试.*构建.*实际输出/s);
  assert.match(text, /逐条.*命令.*结果.*判据.*证据/s);
});

test("验收失败携带证据持续修正，通过后自动关闭", async () => {
  const text = await skill();

  assert.match(text, /验收失败.*失败证据.*send_input.*同一.*Agent/s);
  assert.match(text, /一次性.*不可续聊.*新派.*修正.*Agent/s);
  assert.match(text, /重新.*wait_agent.*再次验收/s);
  assert.match(text, /可续聊.*验收通过.*close_agent.*自动.*关闭.*无需用户.*回收/s);
});

test("声明停止、持久任务、硬阻断和最终交付契约", async () => {
  const text = await skill();

  assert.match(text, /普通子 Agent.*主会话.*停止.*终止/s);
  assert.match(text, /跨会话.*长周期.*Kanban.*持久.*队列/s);
  assert.match(text, /外部凭据.*生产授权.*平台超时.*硬阻断/s);
  assert.match(text, /全部.*验收通过.*才.*完成/s);
  assert.match(text, /未完全完成.*阻断项.*下一步/s);
});

test("下发后立即在主会话公开 Agent 身份、任务、判据和执行状态", async () => {
  const text = await skill();

  assert.match(text, /下发后.*立即.*主会话.*展示/s);
  assert.match(text, /Agent 名称.*Agent ID.*任务.*完成判据.*执行中/s);
});

test("完成通知只进入待验收态，并完整转呈原始报告", async () => {
  const text = await skill();

  assert.match(text, /子 Agent 报告｜待验收/);
  assert.match(text, /原始验收报告.*完整.*原文.*转呈/s);
  assert.match(text, /不得.*摘要.*不得.*宣布完成/s);
});

test("验收失败公开证据与纠偏内容并循环展示", async () => {
  const text = await skill();

  assert.match(text, /验收失败.*主会话.*展示.*失败证据/s);
  assert.match(text, /发给.*Agent.*纠偏内容/s);
  assert.match(text, /同一 Agent.*修复.*新报告.*再次.*验收/s);
});

test("验收通过后公开 close_agent 结果和准确运行状态", async () => {
  const text = await skill();

  assert.match(
    text,
    /验收通过.*close_agent.*Agent 名称.*Agent ID.*返回结果.*运行状态/s,
  );
  assert.match(text, /runtime.*关闭.*不等于.*右侧.*历史卡片.*消失/s);
});

test("最终报告保留全部原始报告、验收、纠偏、关闭和遗留问题", async () => {
  const text = await skill();

  assert.match(
    text,
    /最终报告.*全部 Agent 原始报告.*主验收记录.*纠偏记录.*关闭状态.*遗留问题/s,
  );
});

test("只公开审计证据，不泄露隐藏推理", async () => {
  const text = await skill();

  assert.match(text, /不得.*隐藏推理/s);
  assert.match(text, /只.*可审计.*操作.*输出.*证据.*结论/s);
});
