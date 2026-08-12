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

export function buildTaskCenterPayload(store) {
  return visibleTaskGroups(store).map((group) => {
    const snapshot = store.getTaskGroupSnapshot(group.id) || {};
    return {
      id: group.id,
      title: group.title,
      status: group.status,
      progress: group.progress,
      current_stage: group.current_stage,
      running_workers: group.running_workers,
      blocker_count: group.blocker_count,
      updated_at: group.updated_at,
      demand_events: (snapshot.demand_events || []).slice(-20),
      requirement_revisions: snapshot.requirement_revisions || [],
      work_items: snapshot.work_items || [],
      evidence: (snapshot.evidence || []).slice(-20),
      acceptances: (snapshot.acceptances || []).slice(-20),
    };
  });
}

export function buildTaskCenterBridgeScript(options) {
  const payload = safeJson(options.taskGroups || []);
  const taskboardUrl = safeJson(options.taskboardUrl);
  return `(() => {
    const version = 2;
    const payload = ${payload};
    const taskboardUrl = ${taskboardUrl};
    const existing = window.__ninecodexTaskCenterBridge;
    if (existing?.version === version) {
      existing.update(payload, taskboardUrl);
      return existing.status();
    }
    existing?.destroy?.();

    const state = { payload, taskboardUrl, open: false, selected: null };
    const labels = {
      collecting:"收集中", awaiting_confirmation:"待确认", planning:"规划中",
      executing:"执行中", integrating:"集成中", verifying:"验收中",
      done:"已完成", blocked:"已阻断", paused:"已暂停", canceled:"已取消"
    };
    const columns = [
      ["confirm","待确认",["collecting","awaiting_confirmation","planning"]],
      ["running","进行中",["executing","paused"]],
      ["review","验收中",["integrating","verifying"]],
      ["terminal","已完成 / 阻断",["done","blocked","canceled"]]
    ];
    const taskTitle = row => {
      const value = String(row?.title || "").trim();
      return !value || value === String(row?.id || "")
        ? "未命名任务"
        : /^Codex task(?:\\s+.*)?$/i.test(value) ? "Codex 会话任务" : value;
    };
    const text = (tag, value, className) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = value == null ? "" : String(value);
      return node;
    };
    const icon = () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 20 20");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("fill", "none");
      svg.innerHTML = '<rect x="2.5" y="3" width="15" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6 7h8M6 10h5M6 13h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
      return svg;
    };
    const style = document.createElement("style");
    style.id = "ninecodex-task-center-style";
    style.textContent = \`
      #ninecodex-task-center-panel{position:fixed;inset:0 0 0 275px;z-index:45;color-scheme:inherit;background:var(--color-background-surface,var(--codex-base-surface,#181818));color:var(--color-text-foreground,var(--codex-base-ink,#fff));font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;display:none}
      #ninecodex-task-center-panel[data-open=true]{display:block}
      #ninecodex-task-center-panel *{box-sizing:border-box}
      .nine-tc-shell{height:100%;display:grid;grid-template-rows:58px 1fr}
      .nine-tc-head{display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.084))}
      .nine-tc-title{font-size:18px;font-weight:700}.nine-tc-sub{font-size:12px;color:var(--color-text-foreground-tertiary,rgba(255,255,255,.5))}
      .nine-tc-actions{display:flex;gap:8px}.nine-tc-button{border:1px solid var(--color-border-heavy,var(--color-border,#ddd));border-radius:8px;background:var(--color-background-button-secondary,rgba(255,255,255,.052));color:inherit;padding:6px 10px;cursor:pointer}
      .nine-tc-button:hover{background:var(--color-background-button-secondary-hover,rgba(255,255,255,.078))}
      .nine-tc-main{overflow:auto;padding:18px 20px}.nine-tc-board{display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:12px;align-items:start}
      .nine-tc-column{border:1px solid var(--color-border,rgba(255,255,255,.084));border-radius:12px;background:var(--color-background-panel,#232323);overflow:hidden;min-height:150px}
      .nine-tc-column-head{display:flex;justify-content:space-between;padding:11px 12px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.084));font-weight:650}
      .nine-tc-count{color:var(--color-text-foreground-tertiary,rgba(255,255,255,.5))}.nine-tc-list{display:grid;gap:8px;padding:8px}
      .nine-tc-empty{padding:36px 10px;text-align:center;color:var(--color-text-foreground-tertiary,rgba(255,255,255,.5))}
      .nine-tc-card{width:100%;text-align:left;border:1px solid var(--color-border,rgba(255,255,255,.084));border-radius:9px;background:var(--color-background-elevated-secondary-opaque,var(--color-background-control-opaque,#282828));color:inherit;padding:11px;cursor:pointer}
      .nine-tc-card:hover{background:var(--color-background-button-secondary-hover,rgba(255,255,255,.078))}.nine-tc-card-top{display:flex;justify-content:space-between;gap:8px}
      .nine-tc-card-title{font-weight:650}.nine-tc-badge{font-size:11px;color:var(--color-text-foreground-tertiary,rgba(255,255,255,.5))}
      .nine-tc-progress{height:4px;margin:10px 0 7px;border-radius:9px;background:var(--color-background-control-opaque,#2d2d2d);overflow:hidden}
      .nine-tc-progress>i{display:block;height:100%;background:var(--codex-base-accent,var(--color-accent-blue,#339cff))}.nine-tc-meta{display:flex;justify-content:space-between;color:var(--color-text-foreground-tertiary,rgba(255,255,255,.5));font-size:11px}
      .nine-tc-detail{position:fixed;inset:58px 0 0 auto;width:min(620px,calc(100vw - 295px));z-index:46;background:var(--color-background-surface,var(--codex-base-surface,#181818));border-left:1px solid var(--color-border,rgba(255,255,255,.084));box-shadow:-16px 0 40px rgba(0,0,0,.12);display:none;overflow:auto;padding:20px}
      .nine-tc-detail[data-open=true]{display:block}.nine-tc-detail h2{margin:0 0 4px;font-size:18px}.nine-tc-detail h3{margin:18px 0 7px;font-size:13px}
      .nine-tc-detail-row{padding:8px 9px;margin:6px 0;border:1px solid var(--color-border,rgba(255,255,255,.084));border-radius:8px;background:var(--color-background-panel,#232323);overflow-wrap:anywhere}
      @media(max-width:900px){#ninecodex-task-center-panel{left:0}.nine-tc-board{grid-template-columns:repeat(2,minmax(220px,1fr))}.nine-tc-detail{width:100%}}
    \`;
    document.head.append(style);

    const panel = document.createElement("section");
    panel.id = "ninecodex-task-center-panel";
    panel.setAttribute("aria-label", "9codex 任务中心");
    panel.innerHTML = '<div class="nine-tc-shell"><header class="nine-tc-head"><div><div class="nine-tc-title">9codex 任务中心</div><div class="nine-tc-sub" data-summary></div></div><div class="nine-tc-actions"><button class="nine-tc-button" data-browser>浏览器打开</button><button class="nine-tc-button" data-close>关闭</button></div></header><main class="nine-tc-main"><div class="nine-tc-board" data-board></div></main></div><aside class="nine-tc-detail" data-detail></aside>';
    document.body.append(panel);

    const renderDetail = row => {
      state.selected = row.id;
      const detail = panel.querySelector("[data-detail]");
      detail.replaceChildren();
      const close = text("button", "关闭", "nine-tc-button");
      close.addEventListener("click", () => { detail.dataset.open = "false"; state.selected = null; });
      detail.append(close, text("h2", taskTitle(row)), text("div", (labels[row.status] || row.status) + " · " + Number(row.progress || 0) + "%", "nine-tc-sub"));
      const sections = [
        ["需求", row.requirement_revisions || [], item => item.normalized_requirement || item.title],
        ["工作项", row.work_items || [], item => (item.title || item.id) + " · " + (labels[item.status] || item.status)],
        ["阻断", (row.work_items || []).filter(item => item.status === "blocked"), item => item.title || item.id],
        ["验收证据", row.evidence || [], item => item.output_path || item.content_hash || item.id]
      ];
      for (const [title, rows, format] of sections) {
        detail.append(text("h3", title));
        if (!rows.length) detail.append(text("div", "暂无记录", "nine-tc-sub"));
        else for (const item of rows) detail.append(text("div", format(item), "nine-tc-detail-row"));
      }
      detail.dataset.open = "true";
    };
    const render = () => {
      panel.querySelector("[data-summary]").textContent = state.payload.length + " 个会话任务";
      const board = panel.querySelector("[data-board]");
      board.replaceChildren();
      for (const [, title, statuses] of columns) {
        const rows = state.payload.filter(row => statuses.includes(row.status));
        const column = text("section", "", "nine-tc-column");
        const head = text("header", "", "nine-tc-column-head");
        head.append(text("span", title), text("span", rows.length, "nine-tc-count"));
        const list = text("div", "", "nine-tc-list");
        if (!rows.length) list.append(text("div", "暂无任务", "nine-tc-empty"));
        for (const row of rows) {
          const card = text("button", "", "nine-tc-card");
          card.type = "button";
          const top = text("div", "", "nine-tc-card-top");
          top.append(text("span", taskTitle(row), "nine-tc-card-title"), text("span", labels[row.status] || row.status, "nine-tc-badge"));
          const progress = text("div", "", "nine-tc-progress");
          const fill = document.createElement("i");
          fill.style.width = Math.max(0, Math.min(100, Number(row.progress || 0))) + "%";
          progress.append(fill);
          const meta = text("div", "", "nine-tc-meta");
          meta.append(text("span", "成员 " + Number(row.running_workers || 0)), text("span", "阻断 " + Number(row.blocker_count || 0)));
          card.append(top, progress, meta);
          card.addEventListener("click", () => renderDetail(row));
          list.append(card);
        }
        column.append(head, list);
        board.append(column);
      }
      if (state.selected) {
        const selected = state.payload.find(row => row.id === state.selected);
        if (selected) renderDetail(selected);
      }
    };
    const open = () => { state.open = true; panel.dataset.open = "true"; render(); };
    const close = () => { state.open = false; panel.dataset.open = "false"; };
    panel.querySelector("[data-close]").addEventListener("click", close);
    panel.querySelector("[data-browser]").addEventListener("click", () => window.open(state.taskboardUrl, "_blank", "noopener"));

    const ensureButton = () => {
      if (document.querySelector("#ninecodex-task-center-button")) return true;
      const plugin = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "插件");
      if (!plugin?.parentElement) return false;
      const button = plugin.cloneNode(true);
      button.id = "ninecodex-task-center-button";
      button.removeAttribute("data-state");
      const label = button.querySelector(".text-fade-truncate") || [...button.querySelectorAll("span")].find(node => node.textContent.trim() === "插件");
      if (label) label.textContent = "任务中心";
      const svg = button.querySelector("svg");
      if (svg) svg.replaceWith(icon());
      button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); open(); });
      plugin.after(button);
      return true;
    };
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; ensureButton(); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const applied = ensureButton();
    render();
    window.__ninecodexTaskCenterBridge = {
      version,
      update(nextPayload, nextUrl) {
        state.payload = nextPayload;
        state.taskboardUrl = nextUrl;
        ensureButton();
        if (state.open) render();
      },
      destroy() {
        observer.disconnect();
        panel.remove();
        style.remove();
        document.querySelector("#ninecodex-task-center-button")?.remove();
        delete window.__ninecodexTaskCenterBridge;
      },
      status() {
        return {
          applied: true,
          button: Boolean(document.querySelector("#ninecodex-task-center-button")),
          open: state.open,
          tasks: state.payload.length
        };
      },
      open,
      close
    };
    return { applied: true, button: applied, open: false, tasks: state.payload.length };
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
  if (!results.some((result) => result?.applied && result?.button)) {
    throw new Error("Codex task center bridge was not applied");
  }
  return {
    connected: true,
    verified: true,
    tasks: Math.max(...results.map((result) => Number(result?.tasks) || 0)),
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
