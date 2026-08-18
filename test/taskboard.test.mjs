import assert from "node:assert/strict";
import test from "node:test";

import { createTaskboardServer } from "../lib/taskboard.mjs";

const token = "taskboard_test_token_1234567890";

async function fixture() {
  const calls = [];
  const orchestrator = {
    async ingestDemand(input) {
      calls.push(["demand", input]);
      return { taskGroupId: "tg_1", status: "planning" };
    },
    async confirmDemand(input) {
      calls.push(["confirm", input]);
      return { taskGroupId: "tg_1", status: "executing", confirmed: true };
    },
    async deleteWorkItem(taskGroupId, workItemId) {
      calls.push(["delete-work", taskGroupId, workItemId]);
      return true;
    },
    async stopWorkItem(taskGroupId, workItemId) {
      calls.push(["stop-work", taskGroupId, workItemId]);
      return { workItemId, status: "blocked" };
    },
    async retryWorkItem(taskGroupId, workItemId) {
      calls.push(["retry-work", taskGroupId, workItemId]);
      return { workItemId, status: "ready" };
    },
    async clearTaskGroups() {
      calls.push(["clear-all"]);
      return 1;
    },
    ...Object.fromEntries(["pause", "resume", "cancel"].map((action) => [
      `${action}TaskGroup`,
      async (id, metadata) => {
        calls.push([action, id, metadata]);
        return { id, status: action === "resume" ? "planning" : `${action}d` };
      },
    ])),
  };
  const server = createTaskboardServer({
    token,
    store: {
      listTaskGroups() {
        return [
          {
            id: "tg_1",
            title: "<script>alert(1)</script>",
            status: "paused",
            runtime_kind: "codex",
            origin_thread_id: "origin-thread-1",
            progress: 50,
            running_workers: 0,
            blocker_count: 0,
            updated_at: "2026-08-11T00:00:00.000Z",
            demand_count: 1,
          },
          {
            id: "tg_empty",
            title: "Observed worker",
            status: "collecting",
            progress: 0,
            running_workers: 0,
            blocker_count: 0,
            updated_at: "2026-08-11T00:00:00.000Z",
            demand_count: 0,
          },
        ];
      },
      getTaskGroupSnapshot(id, options) {
        return id === "tg_1" ? {
          id,
          options,
          runtime_kind: "codex",
          origin_thread_id: "origin-thread-1",
          demand_events: [{
            id: "de_1",
            event_key: "thread-1:message-1",
            source_message_id: "message-1",
            source_metadata: {
              page: 2,
              owner: "产品团队",
              url: "https://example.test/specifications/login?revision=1",
            },
            received_at: "2026-08-17T00:58:00.000Z",
            processed_at: "2026-08-17T00:59:00.000Z",
            confirmed_at: "2026-08-17T01:00:00.000Z",
            result_json: {
              summary: "实现邮箱密码登录",
              proposedRequirements: [{
                requirementId: "req_1",
                normalizedRequirement: "实现邮箱密码登录",
              }],
            },
          }],
          requirements: [{ id: "req_1", title: "登录" }],
          requirement_revisions: [{
            id: "rr_1",
            requirement_id: "req_1",
            revision: 1,
            status: "active",
            source_event_id: "de_1",
            source_message_id: "message-1",
            source_kind: "document",
            source_reference: "/very/long/product/documents/login-prd.docx",
            source_fingerprint: "sha256:abcdef1234567890",
            source_metadata: {
              page: 2,
              owner: "产品团队",
              url: "https://example.test/specifications/login?revision=1",
            },
            normalized_requirement: "实现邮箱密码登录",
            created_at: "2026-08-17T00:59:30.000Z",
            confirmed_at: "2026-08-17T01:00:00.000Z",
          }],
          work_items: [{
            id: "wi_1",
            task_group_id: "tg_1",
            requirement_revision_id: "rr_1",
            title: "登录 API",
            status: "closed",
            updated_at: "2026-08-17T01:08:00.000Z",
          }],
          events: [
            {
              id: 1,
              aggregate_type: "task_group",
              aggregate_id: "tg_1",
              event_type: "project_manager.replanned",
              created_at: "2026-08-17T01:01:00.000Z",
              payload: { reason: "requirement_confirmed", requirementRevisionId: "rr_1" },
            },
            {
              id: 2,
              aggregate_type: "work_item",
              aggregate_id: "wi_1",
              event_type: "work_item.status_changed",
              created_at: "2026-08-17T01:08:00.000Z",
              payload: { from: "verifying", to: "closed", reason: "review_complete" },
            },
          ],
          evidence: [{
            id: "ev_1",
            work_item_id: "wi_1",
            run_id: "run_review",
            type: "test",
            source: "verification_runner",
            command: ["npm", "test"],
            exit_code: 0,
            content_hash: "sha256:evidence",
            created_at: "2026-08-17T01:07:00.000Z",
          }],
          acceptances: [{
            id: "ac_1",
            scope: "work_item",
            scope_id: "wi_1",
            result: "passed",
            evidence_ids: ["ev_1"],
            created_at: "2026-08-17T01:07:30.000Z",
          }],
          worker_sessions: options?.includeWorkers ? [
            {
              id: "ws_1",
              work_item_id: "wi_1",
              role: "worker",
              status: "closed",
              runtime_kind: "codex",
              runtime_session_id: "codex-session-1",
              created_at: "2026-08-17T01:02:00.000Z",
              updated_at: "2026-08-17T01:05:00.000Z",
            },
            {
              id: "ws_review",
              work_item_id: "wi_1",
              role: "reviewer",
              status: "closed",
              runtime_kind: "codex",
              runtime_session_id: "codex-review-1",
              created_at: "2026-08-17T01:06:00.000Z",
              updated_at: "2026-08-17T01:07:30.000Z",
            },
          ] : undefined,
          runs: options?.includeWorkers ? [
            {
              id: "run_worker",
              worker_session_id: "ws_1",
              work_item_id: "wi_1",
              requirement_revision_id: "rr_1",
              role: "worker",
              status: "reported",
              runtime_kind: "codex",
              report: { summary: "登录 API 已完成" },
              created_at: "2026-08-17T01:02:00.000Z",
              ended_at: "2026-08-17T01:05:00.000Z",
            },
            {
              id: "run_review",
              worker_session_id: "ws_review",
              work_item_id: "wi_1",
              requirement_revision_id: "rr_1",
              role: "reviewer",
              status: "passed",
              runtime_kind: "codex",
              report: { summary: "测试通过" },
              created_at: "2026-08-17T01:06:00.000Z",
              ended_at: "2026-08-17T01:07:30.000Z",
            },
          ] : undefined,
          checkpoints: options?.includeWorkers ? [] : undefined,
        } : null;
      },
      resolveActiveConversation(threadId) {
        calls.push(["resolve", threadId]);
        return { threadId: "active-thread", requestId: "active-request" };
      },
      changeTaskGroupRuntime(taskGroupId, input) {
        calls.push(["runtime", taskGroupId, input]);
        if (taskGroupId === "tg_active") {
          throw Object.assign(new Error("runtime switch blocked"), { code: "runtime_switch_blocked" });
        }
        return { id: taskGroupId, runtime_kind: input.runtimeKind };
      },
    },
    orchestrator,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("taskboard requires loopback and a strong local token", () => {
  assert.throws(() => createTaskboardServer({ host: "0.0.0.0", token, store: {} }), /loopback/);
  assert.throws(() => createTaskboardServer({ token: "short", store: {} }), /24/);
});

test("taskboard binds omitted demand identity to the only active Codex request", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/demands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "实现登录", workspace: "/repo" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls[0], ["resolve", null]);
    assert.equal(app.calls[1][1].threadId, "active-thread");
    assert.equal(app.calls[1][1].sourceMessageId, "active-request");
  } finally {
    await app.close();
  }
});

test("taskboard scopes missing demand message identity to the supplied thread", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/demands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        thread_id: "thread-1",
        content: "实现登录",
        workspace: "/repo",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls[0], ["resolve", "thread-1"]);
    assert.equal(app.calls[1][1].sourceMessageId, "active-request");
  } finally {
    await app.close();
  }
});

test("taskboard accepts immutable demand events", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/demands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        thread_id: "thread-1",
        source_message_id: "message-1",
        content: "实现登录",
        workspace: "/repo",
        runtime_kind: "deepseek-harness",
        source: {
          kind: "document",
          reference: "login-prd.docx",
          fingerprint: "sha256:abcdef1234567890",
          metadata: { page: 2 },
        },
        proposal: {
          summary: "实现登录",
          questions: [],
          requirements: [{
            key: "login",
            title: "登录",
            normalizedRequirement: "实现邮箱密码登录",
            acceptanceCriteria: ["登录测试通过"],
            workItems: [{ key: "api", title: "登录 API" }],
          }],
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).taskGroupId, "tg_1");
    assert.deepEqual(app.calls[0], ["demand", {
      threadId: "thread-1",
      sourceMessageId: "message-1",
      content: "实现登录",
      workspace: "/repo",
      title: undefined,
      runtimeKind: "deepseek-harness",
      source: {
        kind: "document",
        reference: "login-prd.docx",
        fingerprint: "sha256:abcdef1234567890",
        metadata: { page: 2 },
      },
      proposal: {
        summary: "实现登录",
        questions: [],
        requirements: [{
          key: "login",
          title: "登录",
          normalizedRequirement: "实现邮箱密码登录",
          acceptanceCriteria: ["登录测试通过"],
          workItems: [{ key: "api", title: "登录 API" }],
        }],
      },
    }]);
  } finally {
    await app.close();
  }
});

test("taskboard switches an idle task group runtime", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/task-groups/tg_1/runtime`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runtime_kind: "deepseek-harness", reason: "use harness" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls[0], ["runtime", "tg_1", {
      runtimeKind: "deepseek-harness",
      actor: "user",
      source: "taskboard",
      reason: "use harness",
    }]);
  } finally {
    await app.close();
  }
});

test("taskboard rejects runtime switches while execution is active", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/task-groups/tg_active/runtime`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runtime_kind: "codex" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "runtime_switch_blocked");
  } finally {
    await app.close();
  }
});

test("taskboard rejects an invalid runtime", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/task-groups/tg_1/runtime`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runtime_kind: "unknown" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_runtime_kind");
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("taskboard serves a CSP-isolated page without embedding data", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/`);
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
    assert.match(page, /<title>9codex 任务中心<\/title>/);
    assert.match(page, /setInterval\(refresh,2000\)/);
    assert.match(page, /需要授权访问任务中心/);
    assert.match(page, /请在终端运行以下命令，并打开命令返回的完整链接/);
    assert.match(page, /if\(!token\)\{showAuth\(\);return\}/);
    for (const column of ["待处理", "进行中", "验收中", "已结束"]) {
      assert.match(page, new RegExp(column));
    }
    for (const section of ["Runtime 概览", "待确认需求", "最近需求重排", "实时执行动态", "会话实时输出", "历史尝试"]) {
      assert.match(page, new RegExp(section));
    }
    assert.match(page, /queue_position/);
    assert.match(page, /waiting_reason/);
    assert.match(page, /next_action/);
    assert.match(page, /prefers-color-scheme:dark/);
    assert.match(page, /aria-labelledby="detail-title"/);
    assert.match(page, /\/api\/task-center/);
    assert.match(page, /\/work-items\/"\+encodeURIComponent\(item\.id\)/);
    assert.match(page, /停止当前尝试/);
    assert.match(page, /重试此工作项/);
    assert.match(page, /尝试次数/);
    assert.match(page, /监督心跳/);
    assert.match(page, /Runtime 活动/);
    assert.match(page, /有效进展/);
    assert.match(page, /调用阶段/);
    assert.match(page, /自动修复/);
    assert.match(page, /最后失败/);
    assert.match(page, /\/"\+action/);
    assert.match(page, /确认并执行/);
    assert.match(page, /需求分析师复述/);
    assert.match(page, /确认前缺失信息/);
    assert.match(page, /预计工作项/);
    assert.match(page, /source-meta/);
    assert.match(page, /proposed_requirements/);
    assert.match(page, /requirement_revisions/);
    assert.match(page, /project_manager\.replanned/);
    assert.match(page, /runtime_kind/);
    assert.match(page, /runtime_session_id/);
    assert.match(page, /\/runtime/);
    assert.match(page, /activeGroupStatuses/);
    assert.match(page, /Runtime 切换失败/);
    assert.match(page, /Codex 原生导航/);
    assert.match(page, /item\.runtime_kind==="codex"/);
    assert.doesNotMatch(page, /item\.runtime_kind==="deepseek-harness"[\s\S]{0,200}native-navigation/);
    assert.match(page, /Requirement 审计时间线/);
    for (const auditLabel of [
      "来源",
      "需求分析师复述",
      "用户确认",
      "当前 Revision",
      "项目经理重排",
      "Reviewer",
      "Integrator",
      "验收证据",
    ]) {
      assert.match(page, new RegExp(auditLabel));
    }
    assert.match(page, /source_metadata/);
    assert.match(page, /role\+" Session"/);
    assert.match(page, /sourceChip/);
    assert.match(page, /chip\.title=full/);
    assert.doesNotMatch(page, /proposed_requirement\b|proposed_work_items\b/);
    assert.match(page, /"未命名工作项"/);
    assert.match(page, /当前会话尚未产生可展示输出/);
    assert.match(page, /activity\.command/);
    assert.match(page, /body\.scrollTop=scrollTop/);
    assert.match(page, /dialog\{inset:auto 0 0 0;width:100vw;max-width:none;height:92dvh/);
    assert.match(page, /pre\{max-width:100%;margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word\}/);
    assert.match(page, /\.topbar-inner\{align-items:flex-start;flex-direction:column\}/);
    assert.match(page, /\.header-meta\{justify-content:flex-start\}/);
  } finally {
    await app.close();
  }
});

test("taskboard exposes one global task center and controls one work item", async () => {
  const app = await fixture();
  try {
    const headers = { authorization: `Bearer ${token}` };
    const center = await (await fetch(`${app.base}/api/task-center`, { headers })).json();
    assert.equal(center.task_center.id, "global");
    assert.equal(center.task_center.max_workers, 3);
    assert.equal(
      center.task_center.requirement_revisions[0].source_reference,
      "/very/long/product/documents/login-prd.docx",
    );
    const sourceMetadata = center.task_center.requirement_revisions[0].source_metadata;
    assert.equal(
      (typeof sourceMetadata === "string" ? JSON.parse(sourceMetadata) : sourceMetadata).page,
      2,
    );
    assert.equal(center.task_center.demand_activity[0].event_type, "project_manager.replanned");
    assert.equal(center.task_center.work_items[0].runtime_kind, "codex");
    assert.equal(center.task_center.work_items[0].runtime_session_id, "codex-review-1");
    assert.equal(center.task_center.work_items[0].navigation_thread_id, "origin-thread-1");

    const response = await fetch(`${app.base}/api/task-groups/tg_1/work-items/wi_1`, {
      method: "DELETE",
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls.at(-1), ["delete-work", "tg_1", "wi_1"]);

    const stopped = await fetch(`${app.base}/api/task-groups/tg_1/work-items/wi_1/stop`, {
      method: "POST",
      headers,
    });
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), { workItemId: "wi_1", status: "blocked" });
    assert.deepEqual(app.calls.at(-1), ["stop-work", "tg_1", "wi_1"]);

    const retried = await fetch(`${app.base}/api/task-groups/tg_1/work-items/wi_1/retry`, {
      method: "POST",
      headers,
    });
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { workItemId: "wi_1", status: "ready" });
    assert.deepEqual(app.calls.at(-1), ["retry-work", "tg_1", "wi_1"]);
  } finally {
    await app.close();
  }
});

test("taskboard API authenticates and hides worker sessions by default", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.base}/api/task-groups`)).status, 401);
    const headers = { authorization: `Bearer ${token}` };
    const list = await (await fetch(`${app.base}/api/task-groups`, { headers })).json();
    assert.equal(list.task_groups.length, 1);
    assert.equal(list.task_groups[0].id, "tg_1");
    assert.equal(list.task_groups[0].runtime_kind, "codex");
    const basic = await (await fetch(`${app.base}/api/task-groups/tg_1`, { headers })).json();
    assert.equal(basic.worker_sessions, undefined);
    const advanced = await (await fetch(`${app.base}/api/task-groups/tg_1?advanced=1`, { headers })).json();
    assert.equal(advanced.worker_sessions[0].id, "ws_1");
    assert.equal(advanced.worker_sessions[0].runtime_session_id, "codex-session-1");
    assert.equal(advanced.runs[1].role, "reviewer");
    assert.equal(advanced.evidence[0].content_hash, "sha256:evidence");
    assert.equal(advanced.acceptances[0].result, "passed");
    assert.equal(advanced.requirement_revisions[0].source_metadata.owner, "产品团队");
  } finally {
    await app.close();
  }
});

test("taskboard control actions pass actor and reason to orchestrator", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/task-groups/tg_1/pause`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "user request" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls, [["pause", "tg_1", { actor: "user", reason: "user request" }]]);
  } finally {
    await app.close();
  }
});

test("taskboard confirms a specific pending demand", async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/api/task-groups/tg_1/confirm`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event_key: "thread-1:message-1", approved: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(app.calls[0][0], "confirm");
    assert.equal(app.calls[0][1].eventKey, "thread-1:message-1");
  } finally {
    await app.close();
  }
});
