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
            status: "executing",
            progress: 50,
            running_workers: 1,
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
          demand_events: [{ event_key: "thread-1:message-1" }],
          worker_sessions: options?.includeWorkers ? [{ id: "ws_1" }] : undefined,
        } : null;
      },
      resolveActiveConversation(threadId) {
        calls.push(["resolve", threadId]);
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
    assert.match(page, /<title>9codex 任务中心<\/title>/);
    assert.match(page, /setInterval\(refresh,2000\)/);
    assert.match(page, /需要授权访问任务中心/);
    assert.match(page, /请在终端运行以下命令，并打开命令返回的完整链接/);
    assert.match(page, /if\(!token\)\{showAuth\(\);return\}/);
    for (const column of ["待处理", "进行中", "验收中", "已结束"]) {
      assert.match(page, new RegExp(column));
    }
    for (const section of ["特殊情况待确认", "实时执行动态", "会话实时输出", "历史尝试"]) {
      assert.match(page, new RegExp(section));
    }
    assert.match(page, /queue_position/);
    assert.match(page, /waiting_reason/);
    assert.match(page, /next_action/);
    assert.match(page, /prefers-color-scheme:dark/);
    assert.match(page, /aria-labelledby="detail-title"/);
    assert.match(page, /\/api\/task-center/);
    assert.match(page, /\/work-items\/"\+encodeURIComponent\(item\.id\)/);
    assert.match(page, /确认并执行/);
    assert.match(page, /"未命名工作项"/);
    assert.match(page, /当前会话尚未产生可展示输出/);
    assert.match(page, /activity\.command/);
    assert.match(page, /body\.scrollTop=scrollTop/);
    assert.match(page, /dialog\{inset:auto 0 0 0;width:100vw;max-width:none;height:92dvh/);
  } finally {
    await app.close();
  }
});

test("taskboard exposes one global task center and deletes one work item", async () => {
  const app = await fixture();
  try {
    const headers = { authorization: `Bearer ${token}` };
    const center = await (await fetch(`${app.base}/api/task-center`, { headers })).json();
    assert.equal(center.task_center.id, "global");
    assert.equal(center.task_center.max_workers, 3);

    const response = await fetch(`${app.base}/api/task-groups/tg_1/work-items/wi_1`, {
      method: "DELETE",
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls.at(-1), ["delete-work", "tg_1", "wi_1"]);
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
