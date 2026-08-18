import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyTaskCenterBridge,
  buildTaskCenterBridgeScript,
  buildTaskCenterPayload,
  desktopDebugPort,
  enrichWorkItems,
} from "../lib/task-center-bridge.mjs";

test("task center bridge injects one global task center entry with live worker details", () => {
  const source = buildTaskCenterBridgeScript({
    taskGroups: [{
      id: "tg_1",
      origin_thread_id: "thread-1",
      title: "Login",
      status: "executing",
      progress: 50,
      pending_confirmations: [{
        task_group_id: "tg_1",
        event_key: "thread-1:message-1",
        source: {
          kind: "document",
          reference: "login-prd.docx",
          fingerprint: "sha256:1234567890abcdef",
        },
        summary: "新增登录需求，确认后拆分执行。",
        questions: ["是否包含密码重置？"],
        proposed_requirements: [{
          key: "login",
          title: "登录",
          normalizedRequirement: "实现邮箱密码登录",
          impactSummary: "新增认证入口",
          acceptanceCriteria: ["登录测试通过"],
          workItems: [{ key: "api", title: "登录 API" }],
        }],
      }],
      requirement_revisions: [{
        id: "rr_1",
        revision: 1,
        requirement_title: "登录",
        source_kind: "document",
        source_reference: "login-prd.docx",
        source_fingerprint: "sha256:1234567890abcdef",
        confirmed_at: "2026-08-17T01:00:00.000Z",
      }],
      demand_activity: [{
        event_type: "project_manager.replanned",
        created_at: "2026-08-17T01:01:00.000Z",
        payload: { reason: "requirement_confirmed" },
      }],
    }],
    taskboardUrl: "http://127.0.0.1:10102/#token=local",
  });

  assert.match(source, /任务中心/);
  assert.match(source, /全局监督/);
  assert.match(source, /Reviewer\/Integrator 验收/);
  assert.match(source, /CodexNativeHost/);
  assert.match(source, /MutationObserver/);
  assert.doesNotMatch(source, /setInterval|setTimeout/);
  assert.doesNotMatch(source, /ninecodex-session-tasks-entry/);
  assert.match(source, /ninecodex-session-task-panel/);
  assert.match(source, /data-app-shell-main-surface/);
  assert.match(source, /data-app-shell-main-content-layout/);
  assert.match(source, /data-app-action-sidebar-thread-row/);
  assert.match(source, /ninecodex-task-center-tab/);
  assert.match(source, /data-app-shell-tabs/);
  assert.match(source, /data-app-shell-tab-strip-controller/);
  assert.match(source, /data-app-shell-tab-controller/);
  assert.match(source, /data-app-shell-tab-panel-controller/);
  assert.match(source, /KeyS/);
  assert.match(source, /metaKey/);
  assert.match(source, /altKey/);
  assert.match(source, /const version = 22/);
  assert.doesNotMatch(source, /显示\/隐藏侧边栏|展开面板|KeyB/);
  assert.doesNotMatch(source, /data-close aria-label="关闭任务中心"/);
  assert.match(source, /\.nine-st-board\{display:grid;grid-template-columns:1fr/);
  assert.doesNotMatch(source, /__reactProps|__reactFiber|memoizedProps/);
  assert.match(source, /selectedWorkItemId/);
  assert.match(source, /nine-st-metrics/);
  assert.match(source, /nine-st-item-progress/);
  assert.match(source, /实时执行动态/);
  assert.match(source, /会话实时输出/);
  assert.match(source, /工作项执行详情/);
  assert.match(source, /历史尝试/);
  assert.match(source, /Checkpoint/);
  assert.match(source, /停止当前尝试/);
  assert.match(source, /重试此工作项/);
  assert.match(source, /stop_work_item/);
  assert.match(source, /retry_work_item/);
  assert.match(source, /尝试次数/);
  assert.match(source, /监督心跳/);
  assert.match(source, /Runtime 活动/);
  assert.match(source, /有效进展/);
  assert.match(source, /调用阶段/);
  assert.match(source, /自动修复/);
  assert.match(source, /最后失败/);
  assert.match(source, /删除此工作项/);
  assert.match(source, /清空全部任务/);
  assert.match(source, /在浏览器中打开完整任务板/);
  assert.match(source, /确认并执行/);
  assert.match(source, /需求分析师复述/);
  assert.match(source, /确认前缺失信息/);
  assert.match(source, /预计工作项/);
  assert.match(source, /最近需求重排/);
  assert.match(source, /nine-st-source/);
  assert.match(source, /proposed_requirements/);
  assert.doesNotMatch(source, /proposed_requirement\b|proposed_work_items\b/);
  assert.match(source, /state\.actions\.push/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /actionResults/);
  assert.match(source, /openCodexThread/);
  assert.match(source, /打开 Codex 任务/);
  assert.match(source, /DeepSeek Harness Session 仅供审计，无 Codex 导航目标/);
  assert.match(source, /openWorkItem\(item, card\)/);
  assert.doesNotMatch(source, /card\.addEventListener\("click"[\s\S]{0,180}openCodexThread/);
  assert.match(source, /"Runtime"/);
  assert.match(source, /"Session"/);
  assert.match(source, /existing\.sync/);
  assert.match(source, /window\.__ninecodexTaskCenterBridge/);
  assert.match(source, /--color-background-surface/);
  assert.match(source, /--color-text-foreground/);
  assert.match(source, /--codex-base-accent/);
  assert.match(source, /color-scheme:inherit/);
  assert.match(source, /font:inherit/);
  assert.match(source, /role", "dialog"/);
  assert.match(source, /aria-modal", "true"/);
  assert.match(source, /aria-labelledby", "nine-st-drawer-title"/);
  assert.match(source, /data-panel-head/);
  assert.match(source, /\.inert = inert/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /document\.addEventListener\("keydown", handleDrawerKeydown, true\)/);
  assert.match(source, /document\.addEventListener\("focusin", handleDrawerFocusIn, true\)/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /active === last \|\| !drawer\.contains\(active\)/);
  assert.match(source, /active === first \|\| !drawer\.contains\(active\)/);
  assert.match(source, /drawer\.querySelector\("\[data-drawer-close\]"\)\.focus\(\)/);
  assert.match(source, /trigger\?\.isConnected[\s\S]+trigger\.focus\(\)/);
  assert.match(source, /:focus-visible/);
  assert.match(source, /@container \(max-width:440px\)/);
  assert.match(source, /@container \(max-width:360px\)/);
  assert.match(source, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(source, /\.nine-st-toolbar\{flex-direction:column\}/);
  assert.match(source, /待确认需求（" \+ pendingConfirmations\.length \+ "）/);
  assert.match(source, /Requirement 审计时间线/);
  assert.match(source, /需求分析师复述/);
  assert.match(source, /用户确认/);
  assert.match(source, /项目经理重排/);
  assert.match(source, /Worker 执行/);
  assert.match(source, /Reviewer\/Integrator/);
  assert.match(source, /验收证据/);
  assert.match(source, /data-current=true/);
  assert.doesNotMatch(source, /attachShadow|ShadowRoot|<iframe|createElement\\?\(["']iframe/i);
  assert.doesNotMatch(source, /当前会话任务/);
  assert.doesNotMatch(source, /selectedThreadId/);
  assert.doesNotMatch(source, /origin_thread_id ===/);
  assert.doesNotMatch(source, /rightSidebarFor/);
  assert.doesNotMatch(source, /document\.write|location\.reload/);
});

test("task center bridge delegates all Codex private DOM and React access to CodexNativeHost", () => {
  const bridgeModule = fs.readFileSync(
    new URL("../lib/task-center-bridge.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(bridgeModule, /data-app-shell-tabs|data-app-shell-tab-strip-controller/);
  assert.doesNotMatch(bridgeModule, /__reactProps|__reactFiber/);
  assert.doesNotMatch(bridgeModule, /codex_thread_id/);
  assert.match(bridgeModule, /buildCodexNativeHostSource/);
});

test("task center bridge escapes task content before embedding it in renderer JavaScript", () => {
  const source = buildTaskCenterBridgeScript({
    taskGroups: [{ id: "tg_1", title: "</script><script>alert(1)</script>", status: "blocked" }],
    taskboardUrl: "http://127.0.0.1:10102/",
  });

  assert.doesNotMatch(source, /<\/script>/);
  assert.match(source, /\\u003c\/script>/);
});

test("task center bridge targets only the main renderer", async () => {
  const evaluated = [];
  const result = await applyTaskCenterBridge({
    port: 53111,
    taskGroups: [{ id: "tg_1", status: "executing" }],
    taskboardUrl: "http://127.0.0.1:10102/",
    listTargets: async () => [
      { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay" },
      { id: "worker", type: "service_worker", url: "app://-/worker.js" },
      { id: "main", type: "page", url: "app://-/index.html" },
    ],
    evaluateTarget: async (target, source) => {
      evaluated.push({ target, source });
      return { applied: true, entry: true, tasks: 1, actions: [{ type: "confirm", taskGroupId: "tg_1" }] };
    },
  });

  assert.deepEqual(evaluated.map(({ target }) => target.id), ["main"]);
  assert.deepEqual(result, {
    connected: true,
    verified: true,
    tasks: 1,
    actions: [{ type: "confirm", taskGroupId: "tg_1" }],
  });
});

test("task center payload hides empty observed conversations and includes task detail", () => {
  const store = {
    listTaskGroups() {
      return [
        { id: "empty", status: "collecting", demand_count: 0 },
        {
          id: "active",
          origin_thread_id: "thread-1",
          title: "Active",
          status: "executing",
          demand_count: 1,
          progress: 25,
          current_stage: "executing",
          running_workers: 1,
          blocker_count: 0,
          updated_at: "2026-08-12T00:00:00.000Z",
        },
      ];
    },
    getTaskGroupSnapshot(id) {
      assert.equal(id, "active");
      return {
        demand_events: [{ id: "de_1" }],
        requirement_revisions: [{ id: "rr_1" }],
        work_items: [{ id: "wi_1" }],
        evidence: [{ id: "ev_1" }],
        acceptances: [{ id: "ac_1" }],
        demand_events: [{
          id: "de_1",
          event_key: "thread-1:message-1",
          result_json: JSON.stringify({
            status: "awaiting_confirmation",
            source: {
              kind: "text",
              reference: "Codex message",
              fingerprint: "sha256:abc123",
            },
            summary: "登录需求",
            questions: [],
            proposedRequirements: [{
              key: "login",
              title: "Login",
              normalizedRequirement: "Implement login",
              workItems: [{ key: "a", title: "API" }],
            }],
          }),
        }],
      };
    },
  };

  const payload = buildTaskCenterPayload(store);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, "global");
  assert.equal(payload[0].work_items[0].id, "wi_1");
  assert.deepEqual(payload[0].pending_confirmations, []);
});

test("task center payload exposes only the active pending confirmation", () => {
  const store = {
    listTaskGroups: () => [{
      id: "waiting",
      origin_thread_id: "thread-1",
      status: "awaiting_confirmation",
      demand_count: 1,
    }],
    getTaskGroupSnapshot: () => ({
      demand_events: [{
        event_key: "thread-1:message-1",
        result_json: JSON.stringify({
          status: "awaiting_confirmation",
          source: {
            kind: "document",
            reference: "login-prd.docx",
            fingerprint: "sha256:abcdef1234567890",
            metadata: { page: 2 },
          },
          summary: "新增登录需求",
          questions: ["是否包含密码重置？"],
          proposedRequirements: [{
            key: "login",
            title: "Login",
            normalizedRequirement: "Implement login",
            impactSummary: "Authentication",
            acceptanceCriteria: ["Tests pass"],
            workItems: [{ key: "a", title: "API" }],
          }],
        }),
      }],
    }),
  };

  const [payload] = buildTaskCenterPayload(store);
  assert.equal(payload.pending_confirmations[0].event_key, "thread-1:message-1");
  assert.equal(payload.pending_confirmations[0].source.kind, "document");
  assert.deepEqual(payload.pending_confirmations[0].source.metadata, { page: 2 });
  assert.equal(payload.pending_confirmations[0].summary, "新增登录需求");
  assert.deepEqual(payload.pending_confirmations[0].questions, ["是否包含密码重置？"]);
  assert.equal(payload.pending_confirmations[0].proposed_requirements[0].workItems[0].title, "API");
});

test("task center payload exposes requirement source audit and latest demand replanning", () => {
  const [payload] = buildTaskCenterPayload({
    listTaskGroups: () => [{
      id: "tg_1",
      title: "Login",
      status: "executing",
      demand_count: 1,
      updated_at: "2026-08-17T01:02:00.000Z",
    }],
    getTaskGroupSnapshot: () => ({
      requirements: [{ id: "req_1", title: "Login" }],
      requirement_revisions: [{
        id: "rr_1",
        requirement_id: "req_1",
        revision: 2,
        status: "active",
        source_kind: "document",
        source_reference: "login-prd.docx",
        source_fingerprint: "sha256:abcdef1234567890",
        source_event_id: "de_1",
        confirmed_at: "2026-08-17T01:00:00.000Z",
      }],
      demand_events: [{
        id: "de_1",
        source_message_id: "message-1",
        source_kind: "document",
        source_reference: "/very/long/path/to/login-prd.docx",
        source_fingerprint: "sha256:abcdef1234567890",
        source_metadata: { page: 2, url: "https://example.test/spec/login" },
        received_at: "2026-08-17T00:58:00.000Z",
        confirmed_at: "2026-08-17T01:00:00.000Z",
        result_json: JSON.stringify({
          summary: "需求分析师确认邮箱密码登录。",
          questions: [],
        }),
      }],
      work_items: [
        {
          id: "wi_1",
          task_group_id: "tg_1",
          requirement_revision_id: "rr_1",
          title: "Login API",
          status: "closed",
        },
        {
          id: "wi_stale",
          task_group_id: "tg_1",
          requirement_revision_id: "rr_1",
          title: "历史实现",
          status: "stale",
        },
      ],
      worker_sessions: [
        {
          id: "ws_worker",
          work_item_id: "wi_1",
          role: "worker",
          status: "closed",
          runtime_kind: "codex",
          runtime_session_id: "thread-worker",
          created_at: "2026-08-17T01:02:00.000Z",
          updated_at: "2026-08-17T01:03:00.000Z",
        },
        {
          id: "ws_reviewer",
          work_item_id: "wi_1",
          role: "reviewer",
          status: "closed",
          runtime_kind: "deepseek-harness",
          runtime_session_id: "review-1",
          created_at: "2026-08-17T01:04:00.000Z",
          updated_at: "2026-08-17T01:05:00.000Z",
        },
        {
          id: "ws_integrator",
          work_item_id: "wi_1",
          role: "integrator",
          status: "closed",
          runtime_kind: "codex",
          runtime_session_id: "integrate-1",
          created_at: "2026-08-17T01:06:00.000Z",
          updated_at: "2026-08-17T01:07:00.000Z",
        },
      ],
      runs: [
        {
          id: "run_worker",
          worker_session_id: "ws_worker",
          work_item_id: "wi_1",
          role: "worker",
          status: "passed",
          report: { summary: "实现完成" },
          created_at: "2026-08-17T01:02:00.000Z",
        },
        {
          id: "run_reviewer",
          worker_session_id: "ws_reviewer",
          work_item_id: "wi_1",
          role: "reviewer",
          status: "passed",
          report: { summary: "测试通过" },
          created_at: "2026-08-17T01:04:00.000Z",
        },
        {
          id: "run_integrator",
          worker_session_id: "ws_integrator",
          work_item_id: "wi_1",
          role: "integrator",
          status: "passed",
          report: { summary: "合并完成" },
          created_at: "2026-08-17T01:06:00.000Z",
        },
      ],
      evidence: [{
        id: "ev_1",
        work_item_id: "wi_1",
        run_id: "run_reviewer",
        type: "test",
        source: "verification_runner",
        command: "[\"npm\",\"test\"]",
        exit_code: 0,
        content_hash: "sha256:evidence",
        metadata: { result: "passed" },
        created_at: "2026-08-17T01:05:00.000Z",
      }],
      acceptances: [
        {
          id: "ac_work",
          scope: "work_item",
          scope_id: "wi_1",
          result: "passed",
          evidence_ids: ["ev_1"],
          created_at: "2026-08-17T01:05:30.000Z",
        },
        {
          id: "ac_requirement",
          scope: "requirement",
          scope_id: "rr_1",
          result: "passed",
          evidence_ids: ["ev_1"],
          created_at: "2026-08-17T01:08:00.000Z",
        },
      ],
      events: [
        {
          id: 1,
          event_type: "worker.output",
          created_at: "2026-08-17T00:59:00.000Z",
          payload: {},
        },
        {
          id: 2,
          event_type: "demand_event.received",
          created_at: "2026-08-17T01:00:00.000Z",
          payload: { sourceMessageId: "message-1" },
        },
        {
          id: 3,
          event_type: "project_manager.replanned",
          created_at: "2026-08-17T01:01:00.000Z",
          payload: { reason: "requirement_confirmed" },
        },
      ],
    }),
  });

  assert.equal(payload.requirement_revisions[0].requirement_title, "Login");
  assert.equal(payload.requirement_revisions[0].source_kind, "document");
  assert.equal(payload.requirement_revisions[0].source_reference, "login-prd.docx");
  assert.deepEqual(payload.requirement_revisions[0].source_metadata, {
    page: 2,
    url: "https://example.test/spec/login",
  });
  assert.equal(payload.requirement_revisions[0].confirmed_at, "2026-08-17T01:00:00.000Z");
  assert.deepEqual(
    payload.demand_activity.map((row) => row.event_type),
    ["project_manager.replanned", "demand_event.received"],
  );
  const [audit] = payload.requirement_audits;
  assert.equal(audit.title, "Login");
  assert.equal(audit.revisions[0].current, true);
  assert.equal(audit.revisions[0].analyst_summary, "需求分析师确认邮箱密码登录。");
  assert.equal(audit.revisions[0].source.reference, "login-prd.docx");
  assert.deepEqual(audit.revisions[0].source.metadata, {
    page: 2,
    url: "https://example.test/spec/login",
  });
  assert.deepEqual(
    audit.work_items[0].execution_history.map((row) => row.role),
    ["worker", "reviewer", "integrator"],
  );
  assert.deepEqual(audit.work_items.map((row) => row.id), ["wi_1", "wi_stale"]);
  assert.equal(audit.work_items[0].evidence[0].id, "ev_1");
  assert.equal(audit.work_items[0].acceptances[0].evidence[0].id, "ev_1");
  assert.equal(audit.acceptances[0].id, "ac_requirement");
  assert.equal(audit.replan_events[0].event_type, "project_manager.replanned");
});

test("task center injected UI keeps cards isomorphic, keyboard accessible, narrow, and theme-native", () => {
  const source = buildTaskCenterBridgeScript({
    taskGroups: [{
      id: "global",
      work_items: [
        {
          id: "codex",
          title: "Codex",
          status: "running",
          runtime_kind: "codex",
          navigation_thread_id: "origin-1",
        },
        {
          id: "harness",
          title: "Harness",
          status: "running",
          runtime_kind: "deepseek-harness",
          runtime_session_id: "harness-1",
        },
      ],
      counts: {},
    }],
    taskboardUrl: "http://127.0.0.1:10102/",
  });

  assert.equal((source.match(/card\.addEventListener\("click"/g) || []).length, 1);
  assert.match(source, /openWorkItem\(item, card\)/);
  assert.match(source, /openCodex\.addEventListener\("click"/);
  assert.match(source, /document\.addEventListener\("keydown", handleDrawerKeydown, true\)/);
  assert.match(source, /document\.addEventListener\("focusin", handleDrawerFocusIn, true\)/);
  assert.match(source, /document\.removeEventListener\("keydown", handleDrawerKeydown, true\)/);
  assert.match(source, /document\.removeEventListener\("focusin", handleDrawerFocusIn, true\)/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /setBackgroundInert\(true\)/);
  assert.match(source, /setBackgroundInert\(false\)/);
  assert.match(source, /@container \(max-width:440px\)/);
  assert.match(source, /@container \(max-width:360px\)/);
  assert.match(source, /repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(source, /flex-direction:column/);
  assert.match(source, /color-scheme:inherit/);
  assert.match(source, /var\(--color-background-surface/);
  assert.match(source, /var\(--color-text-foreground/);
  assert.match(source, /var\(--codex-base-accent/);
  assert.match(source, /light-dark\(#b42318,#ffb4ab\)/);
  assert.match(source, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(source, /#fff;background:#fff|#000;background:#000/);
});

test("task center does not present work from blocked groups as queued or running", () => {
  const store = {
    listTaskGroups: () => [{
      id: "blocked-group",
      status: "blocked",
      demand_count: 1,
      running_workers: 0,
    }],
    getTaskGroupSnapshot: () => ({
      status: "blocked",
      work_items: [
        { id: "ready", title: "Queued forever", status: "ready" },
        { id: "rework", title: "Interrupted rework", status: "rework" },
      ],
    }),
  };

  const [payload] = buildTaskCenterPayload(store);
  assert.equal(payload.counts.pending, 0);
  assert.equal(payload.counts.running, 0);
  assert.equal(payload.counts.failed, 2);
  assert.deepEqual(payload.work_items.map((item) => item.status), ["blocked", "blocked"]);
  assert.match(payload.work_items[0].waiting_reason, /不会自动执行/);
});

test("task center moves paused historical work out of the pending lane", () => {
  const [payload] = buildTaskCenterPayload({
    listTaskGroups: () => [{ id: "paused", status: "paused", demand_count: 1 }],
    getTaskGroupSnapshot: () => ({ work_items: [{ id: "wi_1", status: "ready" }] }),
  });

  assert.equal(payload.counts.pending, 0);
  assert.equal(payload.counts.done, 1);
  assert.equal(payload.work_items[0].status, "paused");
});

test("task center enriches queued work with dependency, owner, reason, progress, and next action", () => {
  const [blocked, ready] = enrichWorkItems({
    work_items: [
      { id: "wi_1", title: "First", status: "blocked", priority: 1, updated_at: "2026-08-12T00:00:00.000Z" },
      { id: "wi_2", title: "Second", status: "ready", priority: 0, updated_at: "2026-08-12T00:00:01.000Z" },
    ],
    work_item_dependencies: [{ work_item_id: "wi_2", depends_on_id: "wi_1" }],
    worker_sessions: [{
      id: "ws_1",
      work_item_id: "wi_1",
      role: "worker",
      runtime_kind: "codex",
      runtime_session_id: "internal-thread-1",
      updated_at: "2026-08-12T00:00:02.000Z",
    }],
    runs: [{
      id: "run_1",
      worker_session_id: "ws_1",
      work_item_id: "wi_1",
      runtime_kind: "codex",
      status: "failed",
      updated_at: "2026-08-12T00:00:03.000Z",
    }],
    acceptances: [{ id: "ac_1", scope: "work_item", scope_id: "wi_1", result: "failed", created_at: "2026-08-12T00:00:04.000Z" }],
    events: [{
      aggregate_type: "work_item",
      aggregate_id: "wi_1",
      event_type: "work_item.status_changed",
      payload: { reason: "repeated_failure_fingerprint" },
      created_at: "2026-08-12T00:00:05.000Z",
    }],
  });

  assert.match(blocked.owner, /执行 AI/);
  assert.equal(blocked.runtime_kind, "codex");
  assert.equal(blocked.runtime_session_id, "internal-thread-1");
  assert.equal(blocked.worker_thread_id, "internal-thread-1");
  assert.equal(blocked.execution_history[0].runtime_kind, "codex");
  assert.equal(blocked.execution_history[0].runtime_session_id, "internal-thread-1");
  assert.equal(blocked.execution_history[0].runs[0].runtime_kind, "codex");
  assert.equal(blocked.execution_history[0].runs[0].status, "failed");
  assert.equal(blocked.run_status, "failed");
  assert.equal(blocked.acceptance_result, "failed");
  assert.match(blocked.status_reason, /停止自动重试/);
  assert.equal(ready.queue_position, 1);
  assert.deepEqual(ready.unmet_dependencies, ["wi_1"]);
  assert.match(ready.waiting_reason, /等待依赖/);
  assert.match(ready.next_action, /自动调度/);
});

test("task center exposes real attempt counts and the latest worker failure", () => {
  const [work] = enrichWorkItems({
    work_items: [{
      id: "wi_1",
      title: "Long task",
      status: "blocked",
      updated_at: "2026-08-18T01:00:00.000Z",
    }],
    worker_sessions: [{
      id: "ws_2",
      work_item_id: "wi_1",
      role: "worker",
      status: "interrupted",
      runtime_kind: "codex",
      last_heartbeat_at: "2026-08-18T02:00:00.000Z",
      updated_at: "2026-08-18T02:01:00.000Z",
    }],
    runs: [
      {
        id: "run_1",
        worker_session_id: "ws_1",
        work_item_id: "wi_1",
        role: "worker",
        status: "failed",
        created_at: "2026-08-18T00:00:00.000Z",
      },
      {
        id: "run_2",
        worker_session_id: "ws_2",
        work_item_id: "wi_1",
        role: "worker",
        status: "interrupted",
        created_at: "2026-08-18T01:00:00.000Z",
      },
    ],
    evidence: [{
      id: "ev_1",
      work_item_id: "wi_1",
      type: "worker_process",
      source: "codex",
      exit_code: 17,
      metadata: JSON.stringify({ message: "auth failed" }),
      created_at: "2026-08-18T00:01:00.000Z",
    }],
  });

  assert.equal(work.attempt_count, 2);
  assert.equal(work.failed_attempt_count, 1);
  assert.equal(work.interrupted_attempt_count, 1);
  assert.equal(work.last_heartbeat_at, "2026-08-18T02:00:00.000Z");
  assert.deepEqual(work.last_failure, {
    at: "2026-08-18T00:01:00.000Z",
    source: "codex",
    exit_code: 17,
    metadata: { message: "auth failed" },
  });
});

test("task center reports model-call evidence as the latest failure", () => {
  const [work] = enrichWorkItems({
    work_items: [{ id: "wi_1", status: "blocked" }],
    evidence: [{
      id: "ev_1",
      work_item_id: "wi_1",
      type: "model_call",
      source: "codex",
      metadata: JSON.stringify({ category: "upstream_stream_stalled" }),
      created_at: "2026-08-18T05:00:00.000Z",
    }],
  });

  assert.equal(work.last_failure.at, "2026-08-18T05:00:00.000Z");
  assert.equal(work.last_failure.metadata.category, "upstream_stream_stalled");
});

test("task center separates supervisor heartbeat, runtime activity, progress, and recovery state", () => {
  const [work] = enrichWorkItems({
    work_items: [{ id: "wi_1", title: "Recovering", status: "running" }],
    worker_sessions: [{
      id: "ws_1",
      work_item_id: "wi_1",
      role: "worker",
      status: "running",
      runtime_kind: "codex",
      last_heartbeat_at: "2026-08-18T04:10:00.000Z",
    }],
    runs: [{
      id: "run_1",
      worker_session_id: "ws_1",
      work_item_id: "wi_1",
      role: "worker",
      status: "running",
      created_at: "2026-08-18T04:00:00.000Z",
    }],
    events: [
      {
        event_type: "worker.runtime_activity",
        created_at: "2026-08-18T04:08:00.000Z",
        payload: { workItemId: "wi_1", workerSessionId: "ws_1", phase: "model_waiting" },
      },
      {
        event_type: "worker.output",
        created_at: "2026-08-18T04:05:00.000Z",
        payload: { workItemId: "wi_1", workerSessionId: "ws_1", activity: { text: "editing" } },
      },
      {
        event_type: "project_manager.replanned",
        created_at: "2026-08-18T04:09:00.000Z",
        payload: {
          workItemId: "wi_1",
          reason: "model_call_recovery",
          recoveryAttempt: 2,
          recoveryAction: "rebuild_runtime_session",
        },
      },
    ],
  });

  assert.equal(work.last_heartbeat_at, "2026-08-18T04:10:00.000Z");
  assert.equal(work.last_runtime_event_at, "2026-08-18T04:08:00.000Z");
  assert.equal(work.last_progress_at, "2026-08-18T04:05:00.000Z");
  assert.equal(work.model_call_phase, "model_waiting");
  assert.deepEqual(work.recovery, {
    at: "2026-08-18T04:09:00.000Z",
    attempt: 2,
    action: "rebuild_runtime_session",
  });
});

test("task center navigates Codex cards through the owning native conversation", () => {
  const [payload] = buildTaskCenterPayload({
    listTaskGroups: () => [{
      id: "tg_codex",
      origin_thread_id: "origin-thread-1",
      status: "done",
      demand_count: 1,
    }],
    getTaskGroupSnapshot: () => ({
      work_items: [{ id: "wi_codex", title: "Codex worker", status: "closed" }],
      worker_sessions: [{
        id: "ws_codex",
        work_item_id: "wi_codex",
        role: "worker",
        runtime_kind: "codex",
        runtime_session_id: "worker-thread-1",
        updated_at: "2026-08-14T00:00:01.000Z",
      }],
    }),
  });

  const [item] = payload.work_items;
  assert.equal(item.worker_thread_id, "worker-thread-1");
  assert.equal(item.navigation_thread_id, "origin-thread-1");
});

test("task center audits deepseek-harness sessions without exposing a Codex thread target", () => {
  const [item] = enrichWorkItems({
    work_items: [{
      id: "wi_harness",
      title: "Harness worker",
      status: "running",
      updated_at: "2026-08-14T00:00:00.000Z",
    }],
    worker_sessions: [{
      id: "ws_harness",
      work_item_id: "wi_harness",
      role: "worker",
      runtime_kind: "deepseek-harness",
      runtime_session_id: "harness-session-7",
      updated_at: "2026-08-14T00:00:01.000Z",
    }],
    runs: [{
      id: "run_harness",
      worker_session_id: "ws_harness",
      work_item_id: "wi_harness",
      runtime_kind: "deepseek-harness",
      status: "running",
      updated_at: "2026-08-14T00:00:02.000Z",
    }],
  });

  assert.equal(item.runtime_kind, "deepseek-harness");
  assert.equal(item.runtime_session_id, "harness-session-7");
  assert.equal(Object.hasOwn(item, "worker_thread_id"), false);
  assert.equal(Object.hasOwn(item, "navigation_thread_id"), false);
  assert.equal(item.execution_history[0].runtime_kind, "deepseek-harness");
  assert.equal(item.execution_history[0].runtime_session_id, "harness-session-7");
  assert.equal(item.execution_history[0].runs[0].runtime_kind, "deepseek-harness");
});

test("desktop bridge reads the saved loopback debugging port", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-task-center-"));
  const file = path.join(root, "desktop-session.json");
  fs.writeFileSync(file, JSON.stringify({ debug_port: 53111 }));

  assert.equal(desktopDebugPort(file), 53111);
  assert.equal(desktopDebugPort(path.join(root, "missing.json")), null);
});
