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
      async listTaskGroups() {
        return [{
          id: "tg_1",
          title: "<script>alert(1)</script>",
          status: "executing",
          progress: 50,
          running_workers: 1,
          blocker_count: 0,
          updated_at: "2026-08-11T00:00:00.000Z",
        }];
      },
      async getTaskGroupSnapshot(id, options) {
        return id === "tg_1" ? { id, options, worker_sessions: options.includeWorkers ? [{ id: "ws_1" }] : undefined } : null;
      },
      resolveActiveConversation() {
        return { threadId: "active-thread", requestId: "active-request" };
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
    assert.equal(app.calls[0][1].threadId, "active-thread");
    assert.equal(app.calls[0][1].sourceMessageId, "active-request");
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
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).taskGroupId, "tg_1");
    assert.equal(app.calls[0][0], "demand");
    assert.equal(app.calls[0][1].sourceMessageId, "message-1");
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
    assert.match(page, /setInterval\(refresh,2000\)/);
    for (const section of ["任务目标", "需求变更时间线", "当前执行计划 / DAG", "阻断事项", "测试与构建证据", "最终验收报告"]) {
      assert.match(page, new RegExp(section));
    }
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
    assert.equal(list.task_groups[0].id, "tg_1");
    const basic = await (await fetch(`${app.base}/api/task-groups/tg_1`, { headers })).json();
    assert.equal(basic.worker_sessions, undefined);
    const advanced = await (await fetch(`${app.base}/api/task-groups/tg_1?advanced=1`, { headers })).json();
    assert.equal(advanced.worker_sessions[0].id, "ws_1");
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
