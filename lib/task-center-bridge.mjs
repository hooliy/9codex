import fs from "node:fs";

import {
  evaluateCodexRenderer,
  listCodexRendererTargets,
} from "./model-picker.mjs";

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function visibleTaskGroups(store) {
  return store.listTaskGroups()
    .filter((group) => group.status !== "collecting" || group.demand_count !== 0);
}

function pendingConfirmation(snapshot) {
  for (const event of (snapshot.demand_events || []).slice().reverse()) {
    try {
      const result = JSON.parse(event.result_json || "null");
      if (result?.status === "awaiting_confirmation") {
        return {
          event_key: event.event_key,
          proposed_requirement: result.proposedRequirement || null,
          proposed_work_items: result.proposedWorkItems || [],
        };
      }
    } catch {}
  }
  return null;
}

function parseJson(value, fallback = null) {
  if (value == null || typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function workProgress(item, checkpointCount, outputCount) {
  if (item.status === "closed") return 100;
  if (item.status === "passed") return 95;
  if (["canceled", "stale"].includes(item.status)) return 100;
  if (item.status === "verifying") return 82;
  if (["reported", "revalidate"].includes(item.status)) return 70;
  if (item.status === "assigned") return 10;
  if (item.status === "running") return Math.min(60, 15 + checkpointCount * 7 + outputCount * 2);
  if (item.status === "rework") return 45;
  if (["failed", "blocked"].includes(item.status)) return Math.min(90, Math.max(10, 20 + checkpointCount * 7 + outputCount * 2));
  return 0;
}

export function enrichWorkItems(snapshot = {}) {
  const reasonLabels = {
    worker_created: "已分配执行 AI",
    worker_started: "执行 AI 已开始",
    worker_reported: "执行结果已提交",
    independent_review_started: "独立审查已开始",
    independent_review_failed: "独立审查未通过",
    verification_failed: "验收未通过",
    repeated_failure_fingerprint: "同一失败连续出现，已停止自动重试",
    requirement_revision_superseded: "已被新需求版本替代",
    assignment_failed: "AI 员工分配失败",
    worker_lost: "执行会话失联，等待重新调度",
    rework_ready: "已进入返工队列",
  };
  const items = snapshot.work_items || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const dependencies = new Map(items.map((item) => [item.id, []]));
  for (const edge of snapshot.work_item_dependencies || []) {
    dependencies.get(edge.work_item_id)?.push(edge.depends_on_id);
  }
  const sessions = snapshot.worker_sessions || [];
  const runs = snapshot.runs || [];
  const checkpoints = snapshot.checkpoints || [];
  const events = snapshot.events || [];
  const acceptances = snapshot.acceptances || [];
  const pending = items
    .filter((item) => ["backlog", "ready"].includes(item.status))
    .sort((left, right) => (
      Number(right.priority || 0) - Number(left.priority || 0)
      || String(left.created_at || "").localeCompare(String(right.created_at || ""))
      || String(left.id).localeCompare(String(right.id))
    ));
  const queuePositions = new Map(pending.map((item, index) => [item.id, index + 1]));
  const latest = (rows, predicate) => rows.filter(predicate)
    .sort((left, right) => String(right.updated_at || right.created_at || "")
      .localeCompare(String(left.updated_at || left.created_at || "")))[0] || null;

  return items.map((item) => {
    const dependencyIds = dependencies.get(item.id) || [];
    const unmet = dependencyIds.filter((id) => byId.get(id)?.status !== "closed");
    const itemSessions = sessions.filter((row) => row.work_item_id === item.id);
    const session = latest(itemSessions, () => true);
    const run = latest(runs, (row) => row.work_item_id === item.id);
    const itemCheckpoints = checkpoints.filter((row) => row.work_item_id === item.id);
    const checkpoint = latest(itemCheckpoints, () => true);
    const acceptance = latest(acceptances, (row) => row.scope === "work_item" && row.scope_id === item.id);
    const event = [...events].reverse().find((row) => (
      row.aggregate_type === "work_item"
      && row.aggregate_id === item.id
      && row.event_type === "work_item.status_changed"
    ));
    const reasonCode = event?.payload?.reason || null;
    const reason = reasonLabels[reasonCode] || reasonCode;
    const outputEvents = events
      .filter((row) => row.event_type === "worker.output" && row.payload?.workItemId === item.id)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    const statusEvents = events
      .filter((row) => row.aggregate_type === "work_item" && row.aggregate_id === item.id)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    const currentSessionOutputs = session
      ? outputEvents.filter((row) => row.payload?.workerSessionId === session.id)
      : [];
    const runReport = parseJson(run?.report, run?.report || null);
    const progress = workProgress(item, itemCheckpoints.length, currentSessionOutputs.length);
    let waitingReason = "";
    let nextAction = "";
    if (item.status === "backlog") [waitingReason, nextAction] = ["等待规划", "完成拆分并进入调度队列"];
    else if (item.status === "ready" && unmet.length) {
      waitingReason = `等待依赖：${unmet.map((id) => byId.get(id)?.title || id).join("、")}`;
      nextAction = "依赖闭环后自动调度";
    } else if (item.status === "ready") [waitingReason, nextAction] = ["已就绪，等待可用 AI 员工", "自动分配执行"];
    else if (["assigned", "running"].includes(item.status)) [waitingReason, nextAction] = ["AI 员工执行中", "提交结果后进入独立验收"];
    else if (["reported", "verifying", "revalidate"].includes(item.status)) [waitingReason, nextAction] = ["正在独立审查与验收", "验收通过后关闭；失败则返工"];
    else if (item.status === "rework") [waitingReason, nextAction] = ["验收未通过，等待修正", "修正后重新验收"];
    else if (["failed", "blocked"].includes(item.status)) [waitingReason, nextAction] = [reason || "执行或验收失败", "查看证据并单项修正"];
    else if (["passed", "closed"].includes(item.status)) [waitingReason, nextAction] = ["验收通过", "结果已闭环"];
    else if (item.status === "stale") [waitingReason, nextAction] = ["已被新需求版本替代", "仅保留在历史记录"];
    else if (item.status === "canceled") [waitingReason, nextAction] = ["已取消", "结果已闭环"];
    return {
      ...item,
      dependencies: dependencyIds,
      unmet_dependencies: unmet,
      queue_position: queuePositions.get(item.id) || null,
      owner: session ? `${session.role === "reviewer" ? "审查 AI" : "执行 AI"} · ${session.id}` : "未分配",
      worker_session_id: session?.id || null,
      worker_thread_id: session?.codex_thread_id || null,
      run_status: run?.status || null,
      run_report: runReport,
      output_summary: runReport?.summary || currentSessionOutputs.at(-1)?.payload?.activity?.text || null,
      acceptance_result: ["closed", "passed", "failed", "blocked"].includes(item.status)
        ? acceptance?.result || null
        : null,
      status_reason: reason,
      status_reason_code: reasonCode,
      waiting_reason: waitingReason,
      next_action: nextAction,
      last_activity_at: event?.created_at || run?.updated_at || session?.updated_at || item.updated_at,
      checkpoint: checkpoint?.payload || null,
      progress,
      activity_count: outputEvents.length + statusEvents.length,
      activity: [...statusEvents.map((row) => ({
        at: row.created_at,
        type: row.event_type,
        title: row.payload?.to ? `状态变更：${row.payload.from || "未知"} → ${row.payload.to}` : row.event_type,
        text: reasonLabels[row.payload?.reason] || row.payload?.reason || "",
      })), ...outputEvents.map((row) => ({
        at: row.created_at,
        type: row.payload?.activity?.type || row.event_type,
        title: row.payload?.activity?.item_type || row.payload?.activity?.type || "Worker 输出",
        text: row.payload?.activity?.text || "",
        command: row.payload?.activity?.command || "",
        output: row.payload?.activity?.output || "",
        files: row.payload?.activity?.files || null,
        worker_session_id: row.payload?.workerSessionId || null,
        run_id: row.payload?.runId || null,
      }))].sort((left, right) => String(left.at).localeCompare(String(right.at))).slice(-100),
      execution_history: itemSessions
        .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")))
        .map((entry) => ({
          id: entry.id,
          role: entry.role,
          status: entry.status,
          codex_thread_id: entry.codex_thread_id || null,
          branch: entry.branch || null,
          started_at: entry.created_at,
          updated_at: entry.updated_at,
          runs: runs
            .filter((candidate) => candidate.worker_session_id === entry.id)
            .map((candidate) => ({
              id: candidate.id,
              role: candidate.role,
              status: candidate.status,
              started_at: candidate.started_at,
              ended_at: candidate.ended_at,
              report: parseJson(candidate.report, candidate.report || null),
            })),
        })),
      checkpoint_count: itemCheckpoints.length,
      result_closed: ["closed", "stale", "canceled"].includes(item.status),
    };
  });
}

export function buildTaskCenterPayload(store, options = {}) {
  const groups = visibleTaskGroups(store);
  const snapshots = groups.map((group) => ({
    group,
    snapshot: store.getTaskGroupSnapshot(group.id, { includeWorkers: true }) || {},
  }));
  const workItems = snapshots
    .flatMap(({ group, snapshot }) => enrichWorkItems(snapshot).map((item) => {
      const unfinished = !["passed", "closed", "canceled", "stale", "blocked", "failed"].includes(item.status);
      if (group.status === "paused" && unfinished) {
        return {
          ...item,
          actual_status: item.status,
          status: "paused",
          status_reason: "所属任务已暂停",
          waiting_reason: "所属任务已暂停，归入历史",
          next_action: "恢复任务组后重新进入活动队列",
        };
      }
      return group.status === "blocked" && unfinished
        ? {
            ...item,
            actual_status: item.status,
            status: "blocked",
            status_reason: "所属任务已阻断",
            waiting_reason: "所属任务已阻断，不会自动执行",
            next_action: "查看上游失败证据后单项修正或删除",
          }
        : item;
    }))
    .filter((item) => item.status !== "stale");
  const pending = snapshots
    .filter(({ group }) => group.status === "awaiting_confirmation")
    .map(({ group, snapshot }) => ({ task_group_id: group.id, ...pendingConfirmation(snapshot) }))
    .filter((row) => row.event_key);
  const runningWorkers = groups.reduce((sum, group) => sum + Number(group.running_workers || 0), 0);
  const counts = Object.fromEntries([
    ["pending", workItems.filter((item) => ["backlog", "ready", "rework"].includes(item.status)).length],
    ["running", workItems.filter((item) => ["assigned", "running"].includes(item.status)).length],
    ["verifying", workItems.filter((item) => ["reported", "verifying", "revalidate"].includes(item.status)).length],
    ["done", workItems.filter((item) => ["passed", "closed", "canceled", "stale", "paused"].includes(item.status)).length],
    ["failed", workItems.filter((item) => ["failed", "blocked"].includes(item.status)).length],
  ]);
  const activity = workItems.flatMap((item) => item.activity.map((row) => ({
    ...row,
    work_item_id: item.id,
    work_item_title: item.title,
  }))).sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 80);
  return [{
    id: "global",
    title: "全局任务中心",
    status: runningWorkers ? "executing" : pending.length ? "awaiting_confirmation" : "collecting",
    progress: workItems.length
      ? Math.round(workItems.reduce((sum, item) => sum + Number(item.progress || 0), 0) / workItems.length)
      : 0,
    running_workers: runningWorkers,
    blocker_count: counts.failed,
    max_workers: Math.max(1, Number(options.maxWorkers) || 3),
    updated_at: groups.map((group) => group.updated_at).sort().at(-1) || null,
    work_items: workItems,
    counts,
    activity,
    pending_confirmations: pending,
  }];
  /*
  return groups.map((group) => {
    const snapshot = store.getTaskGroupSnapshot(group.id, { includeWorkers: true }) || {};
    return {
      id: group.id,
      origin_thread_id: group.origin_thread_id,
      title: group.title,
      status: group.status,
      progress: group.progress,
      current_stage: group.current_stage,
      running_workers: group.running_workers,
      blocker_count: group.blocker_count,
      updated_at: group.updated_at,
      demand_events: (snapshot.demand_events || []).slice(-20),
      requirement_revisions: snapshot.requirement_revisions || [],
      work_items: enrichWorkItems(snapshot),
      worker_sessions: snapshot.worker_sessions || [],
      runs: snapshot.runs || [],
      checkpoints: snapshot.checkpoints || [],
      evidence: (snapshot.evidence || []).slice(-20),
      acceptances: (snapshot.acceptances || []).slice(-20),
      pending_confirmation: group.status === "awaiting_confirmation"
        ? pendingConfirmation(snapshot)
        : null,
    };
  });
  */
}

export function buildTaskCenterBridgeScript(options) {
  const payload = safeJson(options.taskGroups || []);
  const taskboardUrl = safeJson(options.taskboardUrl);
  const actionResults = safeJson(options.actionResults || []);
  return `(() => {
    const version = 12;
    const payload = ${payload};
    const taskboardUrl = ${taskboardUrl};
    const actionResults = ${actionResults};
    const existing = window.__ninecodexTaskCenterBridge;
    if (existing?.version === version) {
      existing.update(payload, taskboardUrl, actionResults);
      return existing.sync();
    }
    existing?.destroy?.();
    document.querySelector("#ninecodex-task-center-button")?.remove();
    document.querySelector("#ninecodex-session-task-panel")?.remove();

    const actionStorageKey = "ninecodex-task-center-actions";
    const storedActions = (() => {
      try { return JSON.parse(sessionStorage.getItem(actionStorageKey) || "[]"); }
      catch { return []; }
    })();
    const state = {
      payload,
      taskboardUrl,
      open: true,
      wantOpen: true,
      tabWanted: true,
      selectedGroupId: payload[0]?.id || null,
      selectedWorkItemId: null,
      actions: Array.isArray(storedActions) ? storedActions : [],
      actionErrors: {}
    };
    const saveActions = () => sessionStorage.setItem(actionStorageKey, JSON.stringify(state.actions));
    const enqueueAction = action => {
      const record = { ...action, actionId: action.actionId || crypto.randomUUID() };
      if (!state.actions.some(row => row.actionId === record.actionId)) state.actions.push(record);
      saveActions();
      return record;
    };
    const applyActionResults = results => {
      for (const result of results || []) {
        const action = state.actions.find(row => row.actionId === result.actionId);
        if (!action) continue;
        state.actions = state.actions.filter(row => row.actionId !== result.actionId);
        if (result.ok) delete state.actionErrors[action.eventKey || action.actionId];
        else state.actionErrors[action.eventKey || action.actionId] = result.error || "操作失败";
      }
      saveActions();
    };
    applyActionResults(actionResults);
    const groupLabels = {
      collecting:"收集中", awaiting_confirmation:"待确认", planning:"规划中",
      executing:"执行中", integrating:"集成中", verifying:"验收中",
      awaiting_user:"等待用户", done:"已完成", blocked:"已阻断",
      paused:"已暂停", canceled:"已取消"
    };
    const itemLabels = {
      backlog:"待处理", ready:"待处理", assigned:"进行中", running:"进行中",
      rework:"待返工", reported:"待验收", verifying:"验收中", revalidate:"重新验收",
      passed:"已通过", closed:"已关闭", paused:"已暂停", blocked:"已阻断", failed:"失败",
      canceled:"已取消", stale:"已失效"
    };
    const lanes = [
      ["待处理", ["backlog", "ready", "rework"]],
      ["执行中", ["assigned", "running", "reported", "verifying", "revalidate"]],
      ["已结束", ["passed", "closed", "paused", "canceled", "stale", "blocked", "failed"]]
    ];
    const text = (tag, value, className) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = value == null ? "" : String(value);
      return node;
    };
    const currentGroup = () => state.payload.find(row => row.id === state.selectedGroupId)
      || state.payload[0]
      || null;
    const displayTitle = row => {
      const value = String(row?.title || "").trim();
      if (!value || value === String(row?.id || "") || /^Codex task(?:\\s+.*)?$/i.test(value)) return "未命名任务组";
      return value;
    };
    const taskIcon = () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 20 20");
      svg.setAttribute("width", "20");
      svg.setAttribute("height", "20");
      svg.setAttribute("fill", "none");
      svg.innerHTML = '<rect x="2.5" y="3" width="15" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6 7h8M6 10h5M6 13h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
      return svg;
    };

    const style = document.createElement("style");
    style.id = "ninecodex-session-tasks-style";
    style.textContent = \`
      #ninecodex-session-task-panel{position:fixed;z-index:50;display:none;flex-direction:column;overflow:hidden;color-scheme:inherit;background:var(--color-background-surface,var(--color-background-panel,#181818));color:var(--color-text-foreground,#fff);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
      #ninecodex-session-task-panel[data-open=true]{display:flex}
      #ninecodex-session-task-panel *{box-sizing:border-box}
      .nine-st-head{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 12px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09));background:var(--color-background-surface,var(--color-background-panel,#181818))}
      .nine-st-heading{min-width:0;flex:1}.nine-st-title{font-size:14px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nine-st-sub{font-size:12px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)))}
      .nine-st-icon-button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.nine-st-icon-button:hover{background:var(--color-background-button-secondary-hover,var(--color-background-elevated-secondary-opaque,rgba(255,255,255,.08)))}
      .nine-st-body{flex:1;overflow:auto;padding:12px;background:var(--color-background-surface,var(--color-background-panel,#181818))}
      .nine-st-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-bottom:9px}.nine-st-metric{padding:9px;border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:9px;background:var(--color-background-panel,var(--color-background-elevated-secondary-opaque,#222))}.nine-st-metric-label{font-size:10px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)))}.nine-st-metric-value{margin-top:2px;font-size:17px;font-weight:700}
      .nine-st-summary{display:grid;grid-template-columns:1fr auto;gap:10px;padding:12px;border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px;background:var(--color-background-panel,var(--color-background-elevated-secondary-opaque,#222))}
      .nine-st-status{font-weight:650}.nine-st-stats{text-align:right;font-size:12px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)))}
      .nine-st-progress{grid-column:1/-1;height:4px;border-radius:99px;overflow:hidden;background:var(--color-background-control-opaque,rgba(127,127,127,.22))}.nine-st-progress>i{display:block;height:100%;background:var(--codex-base-accent,var(--color-accent-blue,#339cff))}
      .nine-st-section-title{margin:18px 2px 8px;font-size:12px;font-weight:650;color:var(--color-text-foreground-secondary,var(--color-text-secondary,rgba(255,255,255,.7)))}
      .nine-st-requirement,.nine-st-card{padding:10px 11px;border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:10px;background:var(--color-background-elevated-secondary-opaque,var(--color-background-control-opaque,#282828));overflow-wrap:anywhere}
      .nine-st-requirement+.nine-st-requirement{margin-top:7px}.nine-st-board{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.nine-st-lane{min-width:0;border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:11px;overflow:hidden;background:var(--color-background-panel,#222)}
      .nine-st-lane-head{display:flex;justify-content:space-between;gap:8px;padding:8px 9px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09));font-size:12px;font-weight:650}.nine-st-list{display:grid;gap:6px;padding:6px}.nine-st-card{width:100%;color:inherit;text-align:left;cursor:pointer;font-size:12px}.nine-st-card:hover{border-color:var(--codex-base-accent,var(--color-accent-blue,#339cff))}.nine-st-card-title{font-weight:600}.nine-st-card-meta{margin-top:4px;font-size:11px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)))}
      .nine-st-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.nine-st-live{flex:none;color:var(--codex-base-accent,var(--color-accent-blue,#339cff));font-size:10px}.nine-st-live::before{content:"";display:inline-block;width:6px;height:6px;margin-right:4px;border-radius:50%;background:currentColor;animation:nine-pulse 1.4s infinite}
      .nine-st-item-progress{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px;margin-top:8px}.nine-st-item-track{height:5px;overflow:hidden;border-radius:99px;background:var(--color-background-control-opaque,rgba(127,127,127,.22))}.nine-st-item-track>i{display:block;height:100%;border-radius:inherit;background:var(--codex-base-accent,var(--color-accent-blue,#339cff));transition:width .25s}.nine-st-item-percent{font-size:10px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)))}
      .nine-st-drawer{position:absolute;z-index:2;inset:0 0 0 auto;display:none;width:min(440px,100%);grid-template-rows:auto 1fr auto;border-left:1px solid var(--color-border,rgba(255,255,255,.09));background:var(--color-background-surface,var(--color-background-panel,#181818));box-shadow:-12px 0 36px rgba(0,0,0,.24)}.nine-st-drawer[data-open=true]{display:grid}.nine-st-drawer-head{display:flex;align-items:flex-start;gap:10px;padding:14px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}.nine-st-drawer-title{min-width:0;flex:1;font-weight:650}.nine-st-drawer-body{overflow:auto;padding:14px}.nine-st-detail-row{padding:8px 0;border-bottom:1px solid var(--color-border,rgba(255,255,255,.07));font-size:12px;overflow-wrap:anywhere}.nine-st-detail-label{display:block;margin-bottom:2px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)));font-size:10px}.nine-st-history{margin-top:12px}.nine-st-danger{margin:12px;border:1px solid color-mix(in srgb,#d44 55%,transparent);border-radius:8px;background:transparent;color:#e77;padding:8px 10px;cursor:pointer}
      .nine-st-output{margin-top:7px;padding:9px;border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:8px;background:var(--color-background-panel,#222);white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.nine-st-output-title{font:600 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.nine-st-output-time{margin-left:6px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)));font-weight:400}.nine-st-feed{display:grid;gap:6px;max-height:260px;overflow:auto;padding:8px;border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:10px;background:var(--color-background-panel,#222)}.nine-st-feed-item{font-size:11px}.nine-st-feed-item strong{display:block}.nine-st-feed-item span{color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)))}
      .nine-st-empty{padding:18px 8px;text-align:center;font-size:12px;color:var(--color-text-foreground-tertiary,var(--color-text-secondary,rgba(255,255,255,.55)))}
      .nine-st-confirm{display:grid;gap:8px;margin-top:8px;padding:10px;border:1px solid var(--color-accent-blue,var(--codex-base-accent,#339cff));border-radius:10px;background:color-mix(in srgb,var(--color-accent-blue,var(--codex-base-accent,#339cff)) 10%,transparent)}
      .nine-st-confirm button{padding:8px 10px;border:0;border-radius:8px;background:var(--color-accent-blue,var(--codex-base-accent,#339cff));color:#fff;font:inherit;font-weight:650;cursor:pointer}.nine-st-confirm button:disabled{opacity:.55;cursor:wait}
      .nine-st-toolbar{display:flex;gap:8px;margin-top:12px}.nine-st-browser{flex:1;padding:8px 10px;border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:9px;background:transparent;color:inherit;cursor:pointer}.nine-st-browser:hover{background:var(--color-background-button-secondary-hover,var(--color-background-elevated-secondary-opaque,rgba(255,255,255,.08)))}.nine-st-clear{color:#e77}
      @keyframes nine-pulse{50%{opacity:.25}}
      @media(max-width:430px){.nine-st-board{grid-template-columns:1fr}}
    \`;
    document.head.append(style);

    const panel = document.createElement("section");
    panel.id = "ninecodex-session-task-panel";
    panel.setAttribute("aria-label", "任务中心");
    panel.innerHTML = '<header class="nine-st-head"><span data-icon></span><div class="nine-st-heading"><div class="nine-st-title" data-title>任务中心</div><div class="nine-st-sub" data-sub>项目经理视图 · 独立 AI 员工执行</div></div><button type="button" class="nine-st-icon-button" data-close aria-label="关闭任务中心">×</button></header><main class="nine-st-body" data-body></main>';
    panel.querySelector("[data-icon]").append(taskIcon());
    const drawer = text("aside", "", "nine-st-drawer");
    drawer.setAttribute("aria-label", "工作项执行详情");
    drawer.innerHTML = '<header class="nine-st-drawer-head"><div class="nine-st-drawer-title" data-drawer-title>工作项详情</div><button type="button" class="nine-st-icon-button" data-drawer-close aria-label="关闭工作项详情">×</button></header><div class="nine-st-drawer-body" data-drawer-body></div><button type="button" class="nine-st-danger" data-delete-work>删除此工作项</button>';
    panel.append(drawer);
    document.body.append(panel);

    const detailRow = (body, label, value) => {
      if (value == null || value === "") return;
      const row = text("div", "", "nine-st-detail-row");
      row.append(text("span", label, "nine-st-detail-label"), text("div", value));
      body.append(row);
    };
    const openWorkItem = (item) => {
      state.selectedWorkItemId = item.id;
      drawer.querySelector("[data-drawer-title]").textContent = item.title || item.id;
      const body = drawer.querySelector("[data-drawer-body]");
      body.replaceChildren();
      detailRow(body, "状态", itemLabels[item.status] || item.status);
      detailRow(body, "工作项进度", Number(item.progress || 0) + "%");
      detailRow(body, "当前原因", item.waiting_reason || item.status_reason);
      detailRow(body, "下一动作", item.next_action);
      detailRow(body, "执行者", item.owner);
      detailRow(body, "当前输出摘要", item.output_summary);
      detailRow(body, "Checkpoint", item.checkpoint ? JSON.stringify(item.checkpoint, null, 2) : "");
      detailRow(body, "验收", item.acceptance_result);
      detailRow(body, "最近活动", item.last_activity_at);
      body.append(text("h3", "会话实时输出", "nine-st-history"));
      const visibleActivity = (item.activity || []).filter(row => row.text || row.command || row.output || row.files);
      if (!visibleActivity.length) body.append(text("div", "当前会话尚未产生可展示输出", "nine-st-empty"));
      for (const activity of visibleActivity) {
        const block = text("article", "", "nine-st-output");
        const heading = text("div", activity.title || activity.type || "Worker 输出", "nine-st-output-title");
        heading.append(text("span", activity.at ? new Date(activity.at).toLocaleTimeString("zh-CN") : "", "nine-st-output-time"));
        block.append(heading);
        if (activity.text) block.append(text("div", activity.text));
        if (activity.command) block.append(text("div", "$ " + activity.command));
        if (activity.output) block.append(text("div", activity.output));
        if (activity.files) block.append(text("div", "文件：" + JSON.stringify(activity.files)));
        body.append(block);
      }
      if (item.execution_history?.length) {
        body.append(text("h3", "历史尝试", "nine-st-history"));
        for (const execution of item.execution_history) {
          const role = execution.role === "reviewer" ? "审查 AI" : execution.role === "integrator" ? "集成 AI" : "执行 AI";
          detailRow(
            body,
            role,
            [
              execution.status,
              execution.runs?.length && execution.runs.map(run => (
                run.report?.summary || (run.role || "Run") + " " + run.status
              )).join("；"),
            ].filter(Boolean).join(" · "),
          );
        }
      }
      drawer.dataset.open = "true";
    };
    drawer.querySelector("[data-drawer-close]").addEventListener("click", () => {
      drawer.dataset.open = "false";
      state.selectedWorkItemId = null;
    });
    drawer.querySelector("[data-delete-work]").addEventListener("click", () => {
      const group = currentGroup();
      const item = group?.work_items?.find(row => row.id === state.selectedWorkItemId);
      if (!item) return;
      if (!window.confirm("确定删除此工作项？运行中的 Worker 会先停止，执行会话、Run、Checkpoint、证据与验收记录会永久删除。此操作不可撤销。")) return;
      state.actions.push({ type: "delete_work_item", taskGroupId: item.task_group_id, workItemId: state.selectedWorkItemId });
      drawer.dataset.open = "false";
      state.selectedWorkItemId = null;
    });

    const render = () => {
      const group = currentGroup();
      panel.querySelector("[data-title]").textContent = "任务中心";
      panel.querySelector("[data-sub]").textContent = "全局监督 · 独立 Worker 执行 · Reviewer/Integrator 验收";
      const body = panel.querySelector("[data-body]");
      body.replaceChildren();
      if (!group) {
        body.append(text("div", "暂无工作项", "nine-st-empty"));
        return;
      }
      const metrics = text("section", "", "nine-st-metrics");
      for (const [label, value] of [
        ["待处理", group.counts?.pending || 0],
        ["执行中", group.counts?.running || 0],
        ["验收中", group.counts?.verifying || 0],
        ["已结束", (group.counts?.done || 0) + (group.counts?.failed || 0)],
        ["活动 Worker", Number(group.running_workers || 0) + " / " + Number(group.max_workers || 0)],
        ["成功", group.counts?.done || 0],
        ["失败/阻断", group.counts?.failed || 0],
        ["总体进度", Number(group.progress || 0) + "%"],
      ]) {
        const metric = text("div", "", "nine-st-metric");
        metric.append(text("div", label, "nine-st-metric-label"), text("div", value, "nine-st-metric-value"));
        metrics.append(metric);
      }
      body.append(metrics);
      const summary = text("section", "", "nine-st-summary");
      summary.append(
        text("div", groupLabels[group.status] || group.status, "nine-st-status"),
        text("div", "Worker " + Number(group.running_workers || 0) + "/" + Number(group.max_workers || 0) + " · 阻断 " + Number(group.blocker_count || 0), "nine-st-stats"),
      );
      const progress = text("div", "", "nine-st-progress");
      const fill = document.createElement("i");
      fill.style.width = Math.max(0, Math.min(100, Number(group.progress || 0))) + "%";
      progress.append(fill);
      summary.append(progress);
      body.append(summary);

      for (const pending of group.pending_confirmations || []) {
        body.append(text("h3", "待确认需求", "nine-st-section-title"));
        const confirm = text("section", "", "nine-st-confirm");
        confirm.append(text("strong", "待确认方案"));
        if (pending.proposed_requirement) {
          confirm.append(text("div", pending.proposed_requirement.normalizedRequirement || pending.proposed_requirement.title));
        }
        for (const item of pending.proposed_work_items || []) {
          confirm.append(text("div", "· " + (item.title || item.key)));
        }
        const approve = text("button", "确认并执行");
        approve.type = "button";
        const pendingAction = state.actions.find(row => row.type === "confirm" && row.eventKey === pending.event_key);
        const actionError = state.actionErrors[pending.event_key];
        if (pendingAction) {
          approve.disabled = true;
          approve.textContent = "正在确认…";
        }
        if (actionError) {
          confirm.append(text("div", "确认失败：" + actionError, "nine-st-error"));
        }
        approve.addEventListener("click", () => {
          approve.disabled = true;
          approve.textContent = "正在确认…";
          delete state.actionErrors[pending.event_key];
          enqueueAction({
            type: "confirm",
            taskGroupId: pending.task_group_id,
            eventKey: pending.event_key,
          });
        });
        confirm.append(approve);
        body.append(confirm);
      }

      body.append(text("h3", "工作项", "nine-st-section-title"));
      const board = text("div", "", "nine-st-board");
      for (const [title, statuses] of lanes) {
        const items = (group.work_items || []).filter(item => statuses.includes(item.status) && item.status !== "stale");
        const lane = text("section", "", "nine-st-lane");
        const head = text("header", "", "nine-st-lane-head");
        head.append(text("span", title), text("span", items.length));
        const list = text("div", "", "nine-st-list");
        if (!items.length) list.append(text("div", "暂无", "nine-st-empty"));
        for (const item of items) {
          const card = text("button", "", "nine-st-card");
          card.type = "button";
          const top = text("div", "", "nine-st-card-top");
          top.append(text("div", item.title || item.id, "nine-st-card-title"));
          if (["assigned", "running", "reported", "verifying", "revalidate"].includes(item.status)) {
            top.append(text("span", "实时", "nine-st-live"));
          }
          const itemProgress = text("div", "", "nine-st-item-progress");
          const itemTrack = text("div", "", "nine-st-item-track");
          const itemFill = document.createElement("i");
          itemFill.style.width = Math.max(0, Math.min(100, Number(item.progress || 0))) + "%";
          itemTrack.append(itemFill);
          itemProgress.append(itemTrack, text("span", Number(item.progress || 0) + "%", "nine-st-item-percent"));
          card.append(
            top,
            itemProgress,
            text(
              "div",
              [
                itemLabels[item.status] || item.status,
                item.queue_position && "排队 " + item.queue_position,
                item.worker_thread_id && "独立会话",
                item.run_status && "Run " + item.run_status,
                item.checkpoint_count && "Checkpoint " + item.checkpoint_count,
                item.acceptance_result && "验收 " + item.acceptance_result,
              ].filter(Boolean).join(" · "),
              "nine-st-card-meta",
            ),
          );
          card.addEventListener("click", () => {
            if (item.worker_thread_id && openCodexThread(item.worker_thread_id)) return;
            openWorkItem(item);
          });
          list.append(card);
        }
        lane.append(head, list);
        board.append(lane);
      }
      body.append(board);
      body.append(text("h3", "实时执行动态", "nine-st-section-title"));
      const feed = text("section", "", "nine-st-feed");
      if (!group.activity?.length) feed.append(text("div", "暂无动态", "nine-st-empty"));
      for (const activity of group.activity || []) {
        const row = text("div", "", "nine-st-feed-item");
        row.append(
          text("strong", activity.work_item_title || "工作项"),
          text("span", [
            activity.at && new Date(activity.at).toLocaleTimeString("zh-CN"),
            activity.title || activity.type,
            activity.text || activity.command || activity.output,
          ].filter(Boolean).join(" · ")),
        );
        feed.append(row);
      }
      body.append(feed);
      const toolbar = text("div", "", "nine-st-toolbar");
      const browser = text("button", "在浏览器中打开完整任务板", "nine-st-browser");
      browser.type = "button";
      browser.addEventListener("click", () => window.open(state.taskboardUrl, "_blank", "noopener"));
      const clear = text("button", "清空全部任务", "nine-st-browser nine-st-clear");
      clear.type = "button";
      clear.addEventListener("click", () => {
        if (!window.confirm("确定清空全部任务？所有运行中的 Worker 会先停止，全部任务组、工作项、执行会话、Run、Checkpoint、证据与验收记录会永久删除。此操作不可撤销。")) return;
        enqueueAction({ type: "clear_all" });
      });
      toolbar.append(browser, clear);
      body.append(toolbar);
    };

    const reactProps = node => node?.[Object.keys(node).find(key => key.startsWith("__reactProps"))];
    const reactConversationId = node => {
      const fiberKey = Object.keys(node || {}).find(key => key.startsWith("__reactFiber"));
      let fiber = fiberKey ? node[fiberKey] : null;
      for (let index = 0; fiber && index < 16; index += 1, fiber = fiber.return) {
        if (typeof fiber.memoizedProps?.conversationId === "string") return fiber.memoizedProps.conversationId;
      }
      return null;
    };
    const openCodexThread = threadId => {
      const clickThread = () => {
        const button = [...document.querySelectorAll("nav button")].find(candidate => reactConversationId(candidate) === threadId);
        if (!button) return false;
        reactProps(button)?.onClick?.({ preventDefault() {}, stopPropagation() {} });
        close();
        return true;
      };
      if (clickThread()) return true;
      for (const expand of [...document.querySelectorAll("nav button")].filter(button => button.textContent.trim() === "展开显示")) {
        reactProps(expand)?.onClick?.({ preventDefault() {}, stopPropagation() {} });
      }
      setTimeout(() => {
        if (!clickThread()) {
          const item = currentGroup()?.work_items?.find(row => row.worker_thread_id === threadId);
          if (item) openWorkItem(item);
        }
      }, 100);
      return true;
    };
    const taskPanelHost = () => document.querySelector('[data-app-shell-tabs="true"]');
    const tabList = () => document.querySelector('[data-app-shell-tab-strip-controller="right"] [role="tablist"]');
    const placePanel = () => {
      const host = taskPanelHost();
      if (!host) return false;
      const nativePanel = host.querySelector('[role="tabpanel"]:not(#ninecodex-session-task-panel)');
      if (nativePanel) nativePanel.hidden = state.open;
      panel.style.position = "relative";
      panel.style.inset = "auto";
      panel.style.width = "100%";
      panel.style.height = "auto";
      panel.style.minHeight = "0";
      panel.style.flex = "1 1 auto";
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("data-app-shell-tab-panel-controller", "right");
      if (panel.parentElement !== host) host.append(panel);
      return true;
    };
    const selectTaskTab = selected => {
      document.querySelector("#ninecodex-task-center-tab button[role=tab]")?.setAttribute("aria-selected", String(selected));
      for (const tab of document.querySelectorAll('[data-app-shell-tab-strip-controller="right"] button[role=tab]')) {
        if (!tab.closest("#ninecodex-task-center-tab")) tab.setAttribute("aria-selected", String(!selected));
      }
    };
    const open = () => {
      state.wantOpen = true;
      state.open = true;
      if (!placePanel()) {
        state.open = false;
        const toggles = [...document.querySelectorAll('button[aria-label="显示/隐藏侧边栏"]')];
        const toggle = toggles.find(button => button.getBoundingClientRect().width > 0) || toggles[0];
        reactProps(toggle)?.onClick?.({ preventDefault() {}, stopPropagation() {} });
        return false;
      }
      selectTaskTab(true);
      panel.dataset.open = "true";
      render();
      return true;
    };
    const close = () => {
      state.wantOpen = false;
      state.open = false;
      panel.dataset.open = "false";
      selectTaskTab(false);
      const nativePanel = taskPanelHost()?.querySelector('[role="tabpanel"]:not(#ninecodex-session-task-panel)');
      if (nativePanel) nativePanel.hidden = false;
    };
    const closeTab = () => {
      close();
      state.tabWanted = false;
      document.querySelector("#ninecodex-task-center-tab")?.remove();
    };
    panel.querySelector("[data-close]").addEventListener("click", closeTab);

    const wireButton = (button) => {
      button?.removeAttribute("aria-keyshortcuts");
      button?.querySelector("kbd")?.parentElement?.remove();
      const label = [...(button?.querySelectorAll("span") || [])]
        .find(node => ["插件", "侧边聊天"].includes(node.textContent.trim()));
      if (label) label.textContent = "任务中心";
      const svg = button?.querySelector("svg");
      if (svg) svg.replaceWith(taskIcon());
      button?.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        state.tabWanted = true;
        ensureTaskTab();
        open();
      });
    };
    const ensureMenuEntry = () => {
      const existing = document.querySelector("#ninecodex-session-tasks-entry");
      if (existing?.isConnected) {
        if (state.open) placePanel();
        return true;
      }
      const anchor = [...document.querySelectorAll("button")]
        .find(button => button.textContent.trim().startsWith("侧边聊天"));
      const template = anchor?.closest("li");
      if (template?.parentElement) {
        const entry = template.cloneNode(true);
        entry.id = "ninecodex-session-tasks-entry";
        wireButton(entry.querySelector("button"));
        template.after(entry);
        return true;
      }
      if (!anchor?.parentElement) return false;
      const entry = anchor.cloneNode(true);
      entry.id = "ninecodex-session-tasks-entry";
      wireButton(entry);
      anchor.after(entry);
      return true;
    };
    const ensureEntry = () => ensureMenuEntry();
    const ensureTaskTab = () => {
      const existing = document.querySelector("#ninecodex-task-center-tab");
      if (existing?.isConnected) return true;
      const list = tabList();
      const template = list?.querySelector('[data-app-shell-tab-controller="right"]');
      if (!list) return false;
      const tab = template?.cloneNode(true) || document.createElement("div");
      tab.id = "ninecodex-task-center-tab";
      if (!template) {
        tab.className = "my-auto relative flex min-w-[90px] max-w-[160px] flex-1 items-center overflow-hidden";
        tab.innerHTML = '<div class="relative flex h-7 w-full items-center rounded-lg px-2 py-1"><button type="button" role="tab" class="relative flex min-w-0 flex-1 items-center gap-2 text-sm text-token-text-primary"></button><button type="button" aria-label="关闭任务中心" class="relative z-10 px-1 text-token-text-tertiary">×</button></div>';
        if (list.parentElement) list.parentElement.style.width = "160px";
      }
      tab.removeAttribute("data-app-shell-tab-controller");
      tab.removeAttribute("inert");
      tab.dataset.tabId = "ninecodex-task-center";
      const button = tab.querySelector("button[role=tab]");
      button.replaceChildren(taskIcon(), text("span", "任务中心"));
      button.setAttribute("aria-selected", "false");
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        open();
      });
      for (const closeButton of tab.querySelectorAll("button:not([role=tab])")) {
        closeButton.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          closeTab();
        });
      }
      list.append(tab);
      if (!list.dataset.ninecodexTaskSwitching) {
        list.dataset.ninecodexTaskSwitching = "true";
        list.addEventListener("click", event => {
          const nativeTab = event.target.closest("button[role=tab]");
          if (nativeTab && !nativeTab.closest("#ninecodex-task-center-tab")) close();
        }, true);
      }
      return true;
    };

    const entry = ensureEntry();
    const monitor = setInterval(() => {
      ensureEntry();
      if (state.tabWanted) ensureTaskTab();
      if (state.wantOpen && !state.open) open();
    }, 1000);
    ensureTaskTab();
    queueMicrotask(open);
    window.__ninecodexTaskCenterBridge = {
      version,
      update(nextPayload, nextUrl, nextActionResults) {
        state.payload = nextPayload;
        state.taskboardUrl = nextUrl;
        applyActionResults(nextActionResults);
        if (!state.payload.some(row => row.id === state.selectedGroupId)) {
          state.selectedGroupId = state.payload[0]?.id || null;
        }
        ensureEntry();
        ensureTaskTab();
        if (state.open) render();
      },
      destroy() {
        clearInterval(monitor);
        panel.remove();
        style.remove();
        document.querySelector("#ninecodex-session-tasks-entry")?.remove();
        document.querySelector("#ninecodex-task-center-tab")?.remove();
        document.querySelector("#ninecodex-task-center-button")?.remove();
        delete window.__ninecodexTaskCenterBridge;
      },
      status() {
        return {
          applied: true,
          entry: Boolean(document.querySelector("#ninecodex-session-tasks-entry")),
          open: state.open,
          selectedGroupId: state.selectedGroupId,
          tasks: state.payload.length
        };
      },
      sync() {
        return { ...this.status(), actions: [...state.actions] };
      },
      open,
      close
    };
    return { applied: true, entry, open: state.open, selectedGroupId: state.selectedGroupId, tasks: state.payload.length, actions: [...state.actions] };
  })()`;
}

export async function applyTaskCenterBridge(options) {
  const targets = await (options.listTargets || (() => listCodexRendererTargets(options.port)))();
  const evaluateTarget = options.evaluateTarget || evaluateCodexRenderer;
  const renderers = targets.filter((target) =>
    target.type === "page" && !String(target.url || "").includes("avatar-overlay")
  );
  if (renderers.length === 0) throw new Error("Codex main renderer is not available");
  const source = buildTaskCenterBridgeScript(options);
  const results = [];
  for (const target of renderers) results.push(await evaluateTarget(target, source));
  if (!results.some((result) => result?.applied)) {
    throw new Error("Codex session task bridge was not applied");
  }
  return {
    connected: true,
    verified: true,
    tasks: Math.max(...results.map((result) => Number(result?.tasks) || 0)),
    actions: results.flatMap((result) => result?.actions || []),
  };
}

export function desktopDebugPort(sessionFile) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    return Number.isInteger(session.debug_port) ? session.debug_port : null;
  } catch {
    return null;
  }
}
