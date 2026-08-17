import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../skills/demand-intake/SKILL.md", import.meta.url);
const skill = () => readFile(skillUrl, "utf8");

test("description triggers for continuous demand intake from explicit heterogeneous sources", async () => {
  const text = await skill();
  const description = text.match(/^---\n[\s\S]*?\ndescription:\s*(.+)\n---/)?.[1] ?? "";

  for (const keyword of [
    "文字", "附件", "路径", "Word", "PDF", "表格", "图片", "网页", "钉钉",
    "新需求", "需求变更", "Bug", "验收反馈", "计划", "PRD", "会议纪要",
  ]) assert.match(description, new RegExp(keyword));
  assert.match(description, /默认使用/);
});

test("skill selects existing readers but never scans or guesses a source", async () => {
  const text = await skill();

  for (const reader of ["documents", "pdf", "spreadsheets", "dws"]) {
    assert.match(text, new RegExp(`\\\`${reader}\\\` Skill`));
  }
  assert.match(text, /`browser`.*网页读取工具/);
  assert.match(text, /只读取用户.*明确给出.*来源/s);
  assert.match(text, /禁止.*扫描整机.*猜测/s);
  assert.match(text, /来源不明确.*停止读取.*最小问题/s);
});

test("skill matches the core camelCase Demand Proposal and source contracts", async () => {
  const text = await skill();

  for (const keyword of [
    "source",
    "kind",
    "reference",
    "fingerprint",
    "metadata",
    "summary",
    "questions",
    "requirements",
    "key",
    "requirementId",
    "title",
    "normalizedRequirement",
    "impactSummary",
    "acceptanceCriteria",
    "impactActions",
    "workItems",
    "description",
    "priority",
    "writeSet",
    "readSet",
    "resourceLocks",
    "dependencies",
  ]) assert.match(text, new RegExp(`\\b${keyword}\\b`));
  assert.match(text, /一个输入可产生多个.*requirements/s);
  assert.match(text, /acceptanceCriteria\[\]\.command.*argv 数组/s);
});

test("skill contains none of the obsolete snake_case proposal contract", async () => {
  const text = await skill();

  for (const obsolete of [
    "proposal_id",
    "proposal_type",
    "sources",
    "source_id",
    "requirement_id",
    "source_ids",
    "acceptance_criteria",
    "missing_information",
    "change_set",
    "confirmation_required",
  ]) assert.doesNotMatch(text, new RegExp(`\\b${obsolete}\\b`));
});

test("skill confirms before submitting independent source and proposal parameters", async () => {
  const text = await skill();
  const confirmation = text.indexOf("## 复述与确认");
  const submission = text.indexOf("## 提交 9codex");

  assert.ok(confirmation >= 0 && submission > confirmation);
  assert.match(text, /未明确确认.*不得调用.*task_group_submit/s);
  assert.match(text, /task_group_submit\(\{[\s\S]*content:[\s\S]*source:[\s\S]*proposal:/);
  assert.match(text, /content.*source.*proposal.*独立.*task_group_submit.*参数/s);
  assert.match(text, /不得只提交.*content.*Planner 重复拆分/s);
});

test("skill keeps external material as evidence and creates confirmed revision changes", async () => {
  const text = await skill();

  assert.match(text, /外部.*只是.*来源证据.*Requirement Revision.*执行事实/s);
  assert.match(text, /新.*Demand Proposal.*requirementId.*impactSummary.*impactActions.*等待用户确认.*新的 TeamStore.*Requirement Revision/s);
  assert.match(text, /禁止静默覆盖.*历史提案.*来源证据.*Requirement Revision/s);
});
