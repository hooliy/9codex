import http from "node:http";
import crypto from "node:crypto";
import {
  buildTaskCenterPayload,
  enrichWorkItems,
} from "./task-center-bridge.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const RUNTIME_KINDS = new Set(["codex", "deepseek-harness"]);

function sendJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS);
  response.end(`${JSON.stringify(body)}\n`);
}

function tokenFrom(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function authorized(request, expected) {
  const actual = Buffer.from(tokenFrom(request));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function readJson(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>9codex 任务中心</title>
<style>
:root{
  color-scheme:light dark;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --bg:#f5f5f3;--surface:#fff;--surface-2:#f8f8f6;--surface-3:#efefec;
  --text:#20201e;--muted:#6e6d68;--faint:#98968f;--border:#deddd8;--border-strong:#cac8c1;
  --accent:#3377db;--accent-soft:#e8f0fc;--success:#2e7d4f;--success-soft:#e7f4ec;
  --warning:#a65f00;--warning-soft:#fff1dc;--danger:#b83a3a;--danger-soft:#fbe9e8;
  --shadow:0 14px 40px rgba(30,30,28,.08);--radius:12px;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#191918;--surface:#222220;--surface-2:#282826;--surface-3:#30302d;
  --text:#f0efeb;--muted:#aaa8a1;--faint:#7d7b75;--border:#393936;--border-strong:#4b4a45;
  --accent:#72a7f3;--accent-soft:#243550;--success:#72c894;--success-soft:#20392a;
  --warning:#e8ad58;--warning-soft:#43331c;--danger:#ed8585;--danger-soft:#472828;
  --shadow:0 18px 50px rgba(0,0,0,.28);
}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{min-height:100%}
body{margin:0;background:var(--bg);color:var(--text)}
button{font:inherit;color:inherit}
button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
pre{max-width:100%;margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.app{min-height:100vh}
.topbar{position:sticky;top:0;z-index:10;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(18px)}
.topbar-inner{max-width:1680px;margin:auto;min-height:68px;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand-mark{width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);font-weight:750;box-shadow:0 1px 2px rgba(0,0,0,.06)}
h1{font-size:21px;line-height:1.2;margin:0;letter-spacing:-.02em}
.header-meta,.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sync{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;white-space:nowrap}
.sync-dot{width:7px;height:7px;border-radius:50%;background:var(--warning);box-shadow:0 0 0 3px var(--warning-soft)}
.sync.ok .sync-dot{background:var(--success);box-shadow:0 0 0 3px var(--success-soft)}
.sync.error .sync-dot{background:var(--danger);box-shadow:0 0 0 3px var(--danger-soft)}
.button{min-height:34px;padding:6px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-weight:600}
.button:hover{background:var(--surface-2);border-color:var(--border-strong)}
.button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.button.danger{color:var(--danger)}
.button:disabled{opacity:.45;cursor:not-allowed}
.content{max-width:1680px;margin:auto;padding:24px}
.summary{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:10px;margin-bottom:20px}
.metric{min-height:78px;padding:13px 15px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
.metric-label{color:var(--muted);font-size:12px}
.metric-value{margin-top:3px;font-size:23px;line-height:1.2;font-weight:720;letter-spacing:-.03em}
.metric[data-tone="active"] .metric-value{color:var(--accent)}
.metric[data-tone="warning"] .metric-value{color:var(--warning)}
.metric[data-tone="danger"] .metric-value{color:var(--danger)}
.metric[data-tone="success"] .metric-value{color:var(--success)}
.runtime-panel{margin-bottom:20px;padding:15px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
.runtime-panel h2{margin:0 0 10px;font-size:14px}.runtime-list{display:grid;gap:8px}
.runtime-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(190px,auto) minmax(240px,auto);gap:12px;align-items:center;padding:10px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
.runtime-title{min-width:0;font-weight:650;overflow-wrap:anywhere}.runtime-facts{min-width:0;color:var(--muted);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.runtime-switch{display:flex;justify-content:flex-end;gap:6px}.runtime-switch .button[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.runtime-note{color:var(--muted);font-size:11px;text-align:right}
.board{display:grid;grid-template-columns:repeat(4,minmax(260px,1fr));gap:12px;align-items:start}
.column{min-width:0;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-2);overflow:hidden}
.column-head{min-height:50px;padding:12px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}
.column-title{font-size:13px;font-weight:700}
.count{min-width:24px;height:22px;padding:0 7px;border-radius:999px;background:var(--surface-3);color:var(--muted);display:grid;place-items:center;font-size:12px;font-variant-numeric:tabular-nums}
.column-body{padding:9px;display:grid;gap:9px;min-height:150px}
.task-card{position:relative;width:100%;padding:13px 13px 12px 17px;text-align:left;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.025);overflow:hidden}
.task-card:hover{border-color:var(--border-strong);box-shadow:0 5px 18px rgba(0,0,0,.06);transform:translateY(-1px)}
.status-rail{position:absolute;inset:0 auto 0 0;width:4px;background:var(--faint)}
.task-card[data-tone="active"] .status-rail{background:var(--accent)}
.task-card[data-tone="warning"] .status-rail{background:var(--warning)}
.task-card[data-tone="danger"] .status-rail{background:var(--danger)}
.task-card[data-tone="success"] .status-rail{background:var(--success)}
.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.card-title{font-size:14px;font-weight:680;line-height:1.4;overflow-wrap:anywhere}
.status-badge{flex:none;border-radius:999px;padding:2px 7px;background:var(--surface-3);color:var(--muted);font-size:11px;font-weight:650}
.task-card[data-tone="active"] .status-badge{background:var(--accent-soft);color:var(--accent)}
.task-card[data-tone="warning"] .status-badge{background:var(--warning-soft);color:var(--warning)}
.task-card[data-tone="danger"] .status-badge{background:var(--danger-soft);color:var(--danger)}
.task-card[data-tone="success"] .status-badge{background:var(--success-soft);color:var(--success)}
.progress-row{display:flex;align-items:center;gap:9px;margin-top:13px}
.progress-track{height:5px;flex:1;border-radius:999px;background:var(--surface-3);overflow:hidden}
.progress-fill{height:100%;border-radius:inherit;background:var(--accent);transition:width .25s ease}
.progress-value{width:31px;text-align:right;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.card-meta{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:5px 9px;color:var(--muted);font-size:11px}
.card-meta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-meta span:nth-child(even){text-align:right}
.empty{min-height:128px;display:grid;place-items:center;text-align:center;color:var(--faint);font-size:12px;padding:20px}
.activity-panel,.confirmation-panel{margin-top:16px;padding:15px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
.activity-panel h2,.confirmation-panel h2{margin:0 0 10px;font-size:14px}
.activity-list{display:grid;gap:7px;max-height:320px;overflow:auto}
.activity-row{padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);font-size:12px}
.activity-row strong{display:block}.activity-row small{display:block;margin-top:3px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.confirmation-item{display:grid;gap:10px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2)}
.confirmation-item+.confirmation-item{margin-top:8px}
.source-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font-size:11px}
.source-meta span{max-width:min(100%,320px);padding:2px 6px;border:1px solid var(--border);border-radius:5px;background:var(--surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.demand-summary{line-height:1.6;white-space:pre-wrap}
.demand-list{display:grid;gap:8px}
.demand-card{padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12px}
.demand-card h3{margin:0;font-size:13px}.demand-copy{margin-top:4px;white-space:pre-wrap}.demand-meta{margin-top:5px;color:var(--muted)}
.demand-work{margin-top:7px;padding-top:7px;border-top:1px solid var(--border)}
.demand-questions{padding:9px 10px;border:1px solid color-mix(in srgb,var(--warning) 48%,var(--border));border-radius:8px;background:var(--warning-soft);font-size:12px}
.demand-questions strong{display:block;margin-bottom:4px}
.replan-status{padding:10px 11px;border-left:3px solid var(--accent);border-radius:8px;background:var(--surface-2);font-size:12px}
.replan-status strong{display:block}.replan-status small{display:block;margin-top:3px;color:var(--muted)}
.skeleton{height:132px;border:1px solid var(--border);border-radius:10px;background:linear-gradient(100deg,var(--surface) 20%,var(--surface-3) 40%,var(--surface) 60%);background-size:220% 100%;animation:shimmer 1.5s infinite}
.authorization{min-height:100vh;padding:24px;display:grid;place-items:center}
.authorization[hidden],.app[hidden],.toast[hidden]{display:none}
.auth-card{width:min(440px,100%);padding:30px;border:1px solid var(--border);border-radius:16px;background:var(--surface);box-shadow:var(--shadow);text-align:center}
.auth-icon{width:46px;height:46px;margin:0 auto 16px;display:grid;place-items:center;border-radius:13px;background:var(--warning-soft);color:var(--warning);font-size:21px;font-weight:700}
.auth-card h1{font-size:22px}
.auth-card p{margin:10px 0 0;color:var(--muted)}
.command{margin-top:18px;padding:11px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left}
dialog{width:min(680px,calc(100vw - 24px));height:calc(100vh - 24px);max-height:none;margin:12px 12px 12px auto;padding:0;border:1px solid var(--border);border-radius:14px;background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
dialog::backdrop{background:rgba(0,0,0,.38);backdrop-filter:blur(2px)}
.drawer{height:100%;display:grid;grid-template-rows:auto 1fr auto}
.drawer-head{padding:17px 19px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:14px}
.drawer-title{min-width:0}
.drawer-title h2{margin:0;font-size:18px;line-height:1.35;overflow-wrap:anywhere}
.drawer-subtitle{margin-top:5px;color:var(--muted);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.icon-button{width:34px;height:34px;padding:0;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer;font-size:18px}
.drawer-body{padding:18px 19px;overflow:auto}
.detail-status{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;padding:13px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);margin-bottom:16px}
.detail-progress{margin-top:8px}
.detail-section{padding:15px 0;border-top:1px solid var(--border)}
.detail-section:first-of-type{border-top:0}
.detail-section h3{margin:0 0 9px;color:var(--text);font-size:13px}
.detail-list{display:grid;gap:7px;margin:0;padding:0;list-style:none}
.detail-item{padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);font-size:12px;overflow-wrap:anywhere}
.detail-item small{display:block;margin-top:3px;color:var(--muted)}
.detail-empty{color:var(--faint);font-size:12px}
.audit{display:grid;gap:8px}.audit-revision{padding:12px;border:1px solid var(--border);border-left:3px solid var(--border-strong);border-radius:9px;background:var(--surface-2)}
.audit-revision.current{border-left-color:var(--accent);background:var(--accent-soft)}.audit-revision h4{margin:0;font-size:12px}.audit-revision small{display:block;margin-top:4px;color:var(--muted);overflow-wrap:anywhere}
.timeline{display:grid;gap:0;margin-top:10px}.timeline-item{position:relative;padding:0 0 13px 22px;font-size:12px}.timeline-item::before{content:"";position:absolute;left:5px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--border-strong)}.timeline-item::after{content:"";position:absolute;left:8px;top:15px;bottom:0;width:1px;background:var(--border)}.timeline-item:last-child::after{display:none}.timeline-item.current::before{background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}.timeline-item strong{display:block}.timeline-item small{display:block;margin-top:2px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.native-navigation{margin-top:9px;padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);font-size:12px}.native-navigation small{display:block;margin-top:3px;color:var(--muted);overflow-wrap:anywhere}
.drawer-actions{padding:12px 19px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)}
.toast{position:fixed;z-index:30;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:10px 13px;border:1px solid var(--border-strong);border-radius:9px;background:var(--text);color:var(--bg);box-shadow:var(--shadow);font-size:12px}
.muted{color:var(--muted)}
@keyframes shimmer{to{background-position-x:-220%}}
@media(max-width:1100px){.board{grid-template-columns:repeat(2,minmax(260px,1fr))}.summary{grid-template-columns:repeat(3,1fr)}}
@media(max-width:860px){.runtime-row{grid-template-columns:1fr}.runtime-switch{justify-content:flex-start}.runtime-note{text-align:left}}
@media(max-width:640px){
  .topbar-inner,.content{padding-left:14px;padding-right:14px}.topbar-inner{align-items:flex-start;flex-direction:column}.header-meta{justify-content:flex-start}
  .summary{grid-template-columns:repeat(2,1fr)}.metric:first-child{grid-column:span 2}.board{grid-template-columns:1fr}
  dialog{inset:auto 0 0 0;width:100vw;max-width:none;height:92dvh;margin:0;border-radius:16px 16px 0 0}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style>
</head>
<body>
<section id="authorization" class="authorization" hidden>
  <div class="auth-card">
    <div class="auth-icon" aria-hidden="true">!</div>
    <h1>需要授权访问任务中心</h1>
    <p>当前链接缺少本地访问令牌。请在终端运行以下命令，并打开命令返回的完整链接。</p>
    <div class="command">9codex taskboard</div>
    <p class="muted">令牌只保存在当前浏览器会话中，不会发送到外部服务。</p>
  </div>
</section>
<div id="app" class="app" hidden>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand"><div class="brand-mark" aria-hidden="true">9</div><div><h1>9codex 任务中心</h1><div class="muted" id="task-total">正在读取任务</div></div></div>
      <div class="header-meta">
        <div id="sync" class="sync" role="status" aria-live="polite"><span class="sync-dot"></span><span id="status">连接中</span></div>
        <button id="refresh" class="button" type="button" aria-label="立即刷新任务">刷新</button>
        <button id="clear-all" class="button danger" type="button">清空全部任务</button>
      </div>
    </div>
  </header>
  <main class="content">
    <section class="summary" aria-label="任务概览">
      <div class="metric"><div class="metric-label">待处理</div><div class="metric-value" data-metric="pending">0</div></div>
      <div class="metric" data-tone="active"><div class="metric-label">进行中</div><div class="metric-value" data-metric="running">0</div></div>
      <div class="metric" data-tone="warning"><div class="metric-label">验收中</div><div class="metric-value" data-metric="verifying">0</div></div>
      <div class="metric" data-tone="success"><div class="metric-label">已结束</div><div class="metric-value" data-metric="done">0</div></div>
      <div class="metric" data-tone="danger"><div class="metric-label">失败 / 阻断</div><div class="metric-value" data-metric="failed">0</div></div>
      <div class="metric" data-tone="active"><div class="metric-label">活动 Worker</div><div class="metric-value" data-metric="workers">0 / 0</div></div>
    </section>
    <section id="runtime-overview" class="runtime-panel" aria-label="Runtime 概览" hidden><h2>Runtime 概览</h2><div class="runtime-list" data-runtime-list></div></section>
    <section id="pending-confirmations" class="confirmation-panel" aria-label="待确认需求" hidden><h2>待确认需求</h2><div data-confirmation-list></div></section>
    <section id="demand-activity" class="activity-panel" aria-label="需求重排状态" hidden><h2>最近需求重排</h2><div data-demand-activity></div></section>
    <section id="board" class="board" aria-label="任务看板">
      <section class="column" data-column="pending"><div class="column-head"><h2 class="column-title">待处理</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
      <section class="column" data-column="running"><div class="column-head"><h2 class="column-title">进行中</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
      <section class="column" data-column="review"><div class="column-head"><h2 class="column-title">验收中</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
      <section class="column" data-column="terminal"><div class="column-head"><h2 class="column-title">已结束</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
    </section>
    <section class="activity-panel" aria-label="实时执行动态"><h2>实时执行动态</h2><div id="activity-list" class="activity-list"><div class="skeleton"></div></div></section>
  </main>
</div>
<dialog id="detail-dialog" aria-labelledby="detail-title">
  <div class="drawer">
    <header class="drawer-head"><div class="drawer-title"><h2 id="detail-title">工作项详情</h2><div id="detail-id" class="drawer-subtitle"></div></div><button id="close-detail" class="icon-button" type="button" aria-label="关闭详情">×</button></header>
    <div id="detail-body" class="drawer-body" role="region" tabindex="0" aria-label="工作项详细信息"><div class="skeleton"></div></div>
    <footer class="drawer-actions">
      <button id="detail-refresh" class="button" type="button">刷新详情</button>
      <button id="stop-work" class="button" type="button" hidden>停止当前尝试</button>
      <button id="retry-work" class="button primary" type="button" hidden>重试此工作项</button>
      <button id="delete-work" class="button danger" type="button">删除此工作项</button>
    </footer>
  </div>
</dialog>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<template id="task-card"><button class="task-card" type="button"><span class="status-rail" aria-hidden="true"></span><span class="card-top"><span class="card-title" data-title></span><span class="status-badge" data-status></span></span><span class="progress-row"><span class="progress-track"><span class="progress-fill" data-progress></span></span><span class="progress-value" data-progress-label></span></span><span class="card-meta"><span data-stage></span><span data-workers></span><span data-runtime></span><span data-session></span><span data-blockers></span><span data-updated></span></span></button></template>
<script>
const token=new URLSearchParams(location.hash.slice(1)).get("token")||sessionStorage.token||"";
if(token){sessionStorage.token=token;if(location.hash)history.replaceState(null,"",location.pathname+location.search)}
const headers={authorization:"Bearer "+token};
const esc=v=>v==null?"":String(v);
const workLabels={backlog:"待规划",ready:"就绪",assigned:"已分配",running:"进行中",reported:"已提交",verifying:"验收中",failed:"失败",rework:"待返工",passed:"已通过",closed:"已完成",stale:"已过期",blocked:"已阻断",canceled:"已取消",revalidate:"重新验收"};
const groupLabels={collecting:"收集中",awaiting_confirmation:"待确认",planning:"规划中",executing:"执行中",integrating:"集成中",verifying:"验收中",paused:"已暂停",blocked:"已阻断",done:"已完成",canceled:"已取消"};
const runtimeLabels={codex:"Codex","deepseek-harness":"DeepSeek Harness"};
const activeGroupStatuses=new Set(["planning","executing","integrating","verifying"]);
const columnFor=status=>["backlog","ready","rework"].includes(status)?"pending":["assigned","running"].includes(status)?"running":["reported","verifying","revalidate"].includes(status)?"review":"terminal";
const toneFor=status=>["closed","passed"].includes(status)?"success":["blocked","failed","canceled"].includes(status)?"danger":["backlog","ready","stale"].includes(status)?"warning":"active";
const taskTitle=row=>{const value=String(row.title??"").trim();return !value||value===String(row.id??"")?"未命名工作项":value};
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=esc(text);return node};
const displayValue=value=>typeof value==="string"?value:JSON.stringify(value,null,2);
const shortFingerprint=value=>value?String(value).replace(/^sha256:/,"").slice(0,12):"";
const parseValue=(value,fallback=null)=>{if(value==null)return fallback;if(typeof value!=="string")return value;try{return JSON.parse(value)}catch{return value}};
const compactValue=(value,max=54)=>{const text=displayValue(value);return text.length>max?text.slice(0,max-1)+"…":text};
const relativeTime=value=>{const time=Date.parse(value);if(!Number.isFinite(time))return "时间未知";const seconds=Math.round((time-Date.now())/1000);const unit=Math.abs(seconds)<60?"second":Math.abs(seconds)<3600?"minute":Math.abs(seconds)<86400?"hour":"day";const divisor={second:1,minute:60,hour:3600,day:86400}[unit];return new Intl.RelativeTimeFormat("zh-CN",{numeric:"auto"}).format(Math.round(seconds/divisor),unit)};
let currentCenter=null,currentGroups=[],selectedId=null,selectedSnapshot=null,toastTimer;
async function api(path,options={}){const r=await fetch(path,{...options,headers:{...headers,...options.headers}});if(!r.ok){let message="请求失败";try{const body=await r.json();message=body.error||message}catch{}throw new Error(message)}return r.json()}
function showAuth(){document.querySelector("#authorization").hidden=false;document.querySelector("#app").hidden=true}
function showToast(message){const node=document.querySelector("#toast");node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,3200)}
function setSync(kind,text){const sync=document.querySelector("#sync");sync.className="sync "+kind;document.querySelector("#status").textContent=text}
function renderMetrics(center){const counts=center.counts||{};for(const [key,value] of Object.entries({pending:counts.pending||0,running:counts.running||0,verifying:counts.verifying||0,done:counts.done||0,failed:counts.failed||0,workers:Number(center.running_workers||0)+" / "+Number(center.max_workers||0)}))document.querySelector('[data-metric="'+key+'"]').textContent=value;document.querySelector("#task-total").textContent=(center.work_items||[]).length+" 个工作项 · 总体进度 "+Number(center.progress||0)+"%"}
function runtimeSessions(group){return [...new Set((currentCenter?.work_items||[]).filter(item=>item.task_group_id===group.id&&item.runtime_session_id).map(item=>item.runtime_session_id))]}
function renderRuntimeOverview(groups){const panel=document.querySelector("#runtime-overview"),list=panel.querySelector("[data-runtime-list]");list.replaceChildren();panel.hidden=!groups.length;for(const group of groups){const row=el("article","runtime-row"),title=el("div","runtime-title",group.title||group.id),sessions=runtimeSessions(group),facts=el("div","runtime-facts",[runtimeLabels[group.runtime_kind]||group.runtime_kind||"Runtime 未设置",groupLabels[group.status]||group.status,sessions.length?"Session "+sessions.join("、"):"暂无 Runtime Session"].filter(Boolean).join(" · "));row.append(title,facts);const switchable=!activeGroupStatuses.has(group.status)&&Number(group.running_workers||0)===0;if(switchable){const actions=el("div","runtime-switch");for(const kind of ["codex","deepseek-harness"]){const button=el("button","button",runtimeLabels[kind]);button.type="button";button.setAttribute("aria-pressed",String(group.runtime_kind===kind));button.disabled=group.runtime_kind===kind;button.addEventListener("click",async()=>{button.disabled=true;try{await api("/api/task-groups/"+encodeURIComponent(group.id)+"/runtime",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({runtime_kind:kind,reason:"taskboard runtime switch"})});showToast("Runtime 已切换为 "+runtimeLabels[kind]);await refresh(true)}catch(error){showToast("Runtime 切换失败："+error.message)}finally{button.disabled=false}});actions.append(button)}row.append(actions)}else row.append(el("div","runtime-note","执行活动期间不可切换 Runtime"));list.append(row)}}
function renderCard(row){const node=document.querySelector("#task-card").content.firstElementChild.cloneNode(true);const progress=Math.max(0,Math.min(100,Number(row.progress||0))),title=taskTitle(row);node.dataset.tone=toneFor(row.status);node.setAttribute("aria-label",title+"，"+(workLabels[row.status]||"状态未知")+"，进度 "+progress+"%");
node.querySelector("[data-title]").textContent=title;node.querySelector("[data-status]").textContent=workLabels[row.status]||"状态未知";node.querySelector("[data-progress]").style.width=progress+"%";node.querySelector("[data-progress-label]").textContent=progress+"%";
node.querySelector("[data-stage]").textContent=[row.queue_position&&"排队 "+row.queue_position,row.waiting_reason||workLabels[row.status]||"状态未知"].filter(Boolean).join(" · ");node.querySelector("[data-workers]").textContent=row.owner||"未分配";node.querySelector("[data-runtime]").textContent="Runtime "+(runtimeLabels[row.runtime_kind]||row.runtime_kind||"未分配");node.querySelector("[data-session]").textContent=row.runtime_session_id?"Session "+row.runtime_session_id:"Session 未创建";node.querySelector("[data-session]").title=row.runtime_session_id||"";node.querySelector("[data-blockers]").textContent=row.next_action||"";node.querySelector("[data-updated]").textContent=relativeTime(row.last_activity_at||row.updated_at);
node.addEventListener("click",()=>openDetail(row.id));return node}
function renderBoard(rows){for(const column of document.querySelectorAll("[data-column]")){const key=column.dataset.column;const matches=rows.filter(row=>columnFor(row.status)===key);const list=column.querySelector("[data-list]");list.replaceChildren();column.querySelector("[data-count]").textContent=matches.length;if(matches.length)for(const row of matches)list.append(renderCard(row));else list.append(el("div","empty","暂无任务"))}}
function detailRow(body,label,value){if(value==null||value==="")return;const text=displayValue(value),row=el("div","detail-item");row.append(el("strong","",label),el("small","",text));row.title=text;body.append(row)}
function sourceMetadata(source){const value=parseValue(source?.source_metadata??source?.metadata,{});return value&&typeof value==="object"?value:{}}
function timelineEntry(title,detail,time,current=false){return{title,detail:[time&&new Date(time).toLocaleString("zh-CN"),detail].filter(Boolean).join(" · "),time:time||"",current}}
function renderRequirementAudit(body,item,snapshot){const selectedRevision=(snapshot.requirement_revisions||[]).find(row=>row.id===item.requirement_revision_id);if(!selectedRevision)return;const requirement=(snapshot.requirements||[]).find(row=>row.id===selectedRevision.requirement_id),revisions=(snapshot.requirement_revisions||[]).filter(row=>row.requirement_id===selectedRevision.requirement_id),revisionIds=new Set(revisions.map(row=>row.id)),workItems=(snapshot.work_items||[]).filter(row=>revisionIds.has(row.requirement_revision_id)),workIds=new Set(workItems.map(row=>row.id)),runIds=new Set((snapshot.runs||[]).filter(row=>workIds.has(row.work_item_id)||revisionIds.has(row.requirement_revision_id)).map(row=>row.id)),entries=[];body.append(el("h3","detail-section","Requirement 审计时间线"));detailRow(body,"Requirement",requirement?.title||selectedRevision.normalized_requirement);
const revisionsBox=el("div","audit");for(const revision of revisions){const current=revision.status==="active",card=el("article","audit-revision"+(current?" current":"")),demand=(snapshot.demand_events||[]).find(row=>row.id===revision.source_event_id)||[...(snapshot.demand_events||[])].reverse().find(row=>row.source_message_id===revision.source_message_id),demandMetadata=sourceMetadata(demand),metadata=Object.keys(demandMetadata).length?demandMetadata:sourceMetadata(revision),result=parseValue(demand?.result_json,{}),proposal=(result?.proposedRequirements||result?.proposal?.requirements||[]).find(row=>!row.requirementId||row.requirementId===revision.requirement_id);card.append(el("h4","",["Revision "+revision.revision,current&&"当前 Revision",revision.status].filter(Boolean).join(" · ")));card.append(el("small","",revision.normalized_requirement));if(revision.source_reference){const source=el("small","","来源 "+revision.source_reference);source.title=revision.source_reference;card.append(source)}if(Object.keys(metadata).length){const meta=el("small","","metadata "+compactValue(metadata));meta.title=displayValue(metadata);card.append(meta)}revisionsBox.append(card);
entries.push(timelineEntry("来源",[revision.source_kind,revision.source_reference,revision.source_fingerprint&&"指纹 "+shortFingerprint(revision.source_fingerprint),Object.keys(metadata).length&&"metadata "+displayValue(metadata)].filter(Boolean).join(" · "),demand?.received_at||revision.created_at,current));if(result?.summary)entries.push(timelineEntry("需求分析师复述",result.summary,demand?.processed_at||demand?.received_at,current));if(proposal?.normalizedRequirement)entries.push(timelineEntry("Proposal",proposal.normalizedRequirement,demand?.processed_at||revision.created_at,current));entries.push(timelineEntry("Revision "+revision.revision+" 创建",revision.normalized_requirement,revision.created_at,current));if(revision.confirmed_at||demand?.confirmed_at)entries.push(timelineEntry("用户确认","已确认 Revision "+revision.revision,revision.confirmed_at||demand.confirmed_at,current))}
for(const event of snapshot.events||[]){const payload=parseValue(event.payload,{})||{};if(event.event_type==="project_manager.replanned"){const linked=!payload.requirementId&&!payload.requirementRevisionId&&!payload.workItemId||payload.requirementId===selectedRevision.requirement_id||revisionIds.has(payload.requirementRevisionId)||workIds.has(payload.workItemId);if(linked)entries.push(timelineEntry("项目经理重排",[payload.reason,payload.summary].filter(Boolean).join(" · "),event.created_at,revisionIds.has(payload.requirementRevisionId)||!payload.requirementRevisionId&&selectedRevision.status==="active"))}else if(workIds.has(event.aggregate_id)||workIds.has(payload.workItemId)){entries.push(timelineEntry(event.event_type==="worker.output"?"Worker 执行输出":"工作项事件",[event.event_type,payload.reason,payload.activity?.text].filter(Boolean).join(" · "),event.created_at,workItems.find(row=>row.id===(payload.workItemId||event.aggregate_id))?.requirement_revision_id===selectedRevision.id))}}
for(const session of snapshot.worker_sessions||[]){if(!workIds.has(session.work_item_id))continue;const role=session.role==="reviewer"?"Reviewer":session.role==="integrator"?"Integrator":"Worker",revisionId=workItems.find(row=>row.id===session.work_item_id)?.requirement_revision_id;entries.push(timelineEntry(role+" Session",[session.status,"Runtime "+session.runtime_kind,session.runtime_session_id&&"Session "+session.runtime_session_id].filter(Boolean).join(" · "),session.created_at,revisionId===selectedRevision.id))}
for(const run of snapshot.runs||[]){if(!runIds.has(run.id))continue;const report=parseValue(run.report,run.report),role=run.role==="reviewer"?"Reviewer":run.role==="integrator"?"Integrator":"Worker";entries.push(timelineEntry(role+" Run",[run.status,report?.summary||report].filter(Boolean).join(" · "),run.ended_at||run.updated_at||run.created_at,run.requirement_revision_id===selectedRevision.id))}
for(const acceptance of snapshot.acceptances||[]){const relevant=acceptance.scope==="requirement"&&revisionIds.has(acceptance.scope_id)||acceptance.scope==="work_item"&&workIds.has(acceptance.scope_id)||acceptance.scope==="task_group";if(relevant)entries.push(timelineEntry("验收 "+acceptance.scope,[acceptance.result,acceptance.failure_reason,acceptance.evidence_ids?.length&&"证据 "+acceptance.evidence_ids.join("、")].filter(Boolean).join(" · "),acceptance.created_at,acceptance.scope_id===selectedRevision.id||workItems.find(row=>row.id===acceptance.scope_id)?.requirement_revision_id===selectedRevision.id))}
for(const evidence of snapshot.evidence||[]){if(!workIds.has(evidence.work_item_id)&&!runIds.has(evidence.run_id))continue;entries.push(timelineEntry("验收证据",[evidence.type,evidence.source,evidence.command,evidence.exit_code!=null&&"exit "+evidence.exit_code,evidence.content_hash&&"hash "+evidence.content_hash].filter(Boolean).join(" · "),evidence.created_at,workItems.find(row=>row.id===evidence.work_item_id)?.requirement_revision_id===selectedRevision.id))}
body.append(revisionsBox);const timeline=el("div","timeline");entries.sort((left,right)=>String(left.time).localeCompare(String(right.time)));for(const entry of entries){const row=el("article","timeline-item"+(entry.current?" current":""));row.append(el("strong","",entry.title),el("small","",entry.detail));timeline.append(row)}if(!entries.length)timeline.append(el("div","detail-empty","暂无审计事件"));body.append(timeline)}
function renderDetail(item,snapshot,scrollTop=0){const body=document.querySelector("#detail-body"),progress=Math.max(0,Math.min(100,Number(item.progress||0)));body.replaceChildren();const status=el("div","detail-status");const statusText=el("div");statusText.append(el("strong","",workLabels[item.status]||"状态未知"));const track=el("div","progress-track detail-progress"),fill=el("div","progress-fill");fill.style.width=progress+"%";track.append(fill);statusText.append(track);status.append(statusText,el("strong","",progress+"%"));body.append(status);
detailRow(body,"当前原因",item.waiting_reason||item.status_reason);detailRow(body,"下一动作",item.next_action);detailRow(body,"尝试次数",item.attempt_count);detailRow(body,"失败 / 中断",Number(item.failed_attempt_count||0)+" / "+Number(item.interrupted_attempt_count||0));detailRow(body,"开始时间",item.running_since);detailRow(body,"监督心跳",item.last_heartbeat_at);detailRow(body,"Runtime 活动",item.last_runtime_event_at);detailRow(body,"有效进展",item.last_progress_at);detailRow(body,"调用阶段",item.model_call_phase);detailRow(body,"自动修复",item.recovery);detailRow(body,"最后输出",item.last_output_at);detailRow(body,"最后失败",item.last_failure);detailRow(body,"执行者",item.owner);detailRow(body,"Runtime",runtimeLabels[item.runtime_kind]||item.runtime_kind);detailRow(body,"Runtime Session",item.runtime_session_id||"尚未创建");if(item.runtime_kind==="codex"){const navigation=el("div","native-navigation");navigation.append(el("strong","","Codex 原生导航"));navigation.append(el("small","",item.navigation_thread_id?"原生任务 "+item.navigation_thread_id:"当前工作项无可用 Codex 原生任务目标"));if(item.navigation_thread_id)navigation.title=item.navigation_thread_id;body.append(navigation)}renderRequirementAudit(body,item,snapshot);detailRow(body,"当前输出摘要",item.output_summary);detailRow(body,"Checkpoint",item.checkpoint);detailRow(body,"验收",item.acceptance_result);detailRow(body,"最近活动",item.last_activity_at);
body.append(el("h3","detail-section","会话实时输出"));const visible=(item.activity||[]).filter(row=>row.text||row.command||row.output||row.files);if(!visible.length)body.append(el("div","detail-empty","当前会话尚未产生可展示输出"));for(const activity of visible){const block=el("article","detail-item");block.append(el("strong","",activity.title||activity.type||"Worker 输出"));if(activity.at)block.append(el("small","",new Date(activity.at).toLocaleString("zh-CN")));if(activity.text)block.append(el("pre","",activity.text));if(activity.command)block.append(el("pre","","$ "+activity.command));if(activity.output)block.append(el("pre","",activity.output));if(activity.files)block.append(el("pre","","文件："+JSON.stringify(activity.files,null,2)));body.append(block)}
body.append(el("h3","detail-section","历史尝试"));if(!item.execution_history?.length)body.append(el("div","detail-empty","暂无历史尝试"));for(const execution of item.execution_history||[])detailRow(body,execution.role==="reviewer"?"Reviewer":execution.role==="integrator"?"Integrator":"Worker",[execution.status,execution.runtime_kind&&"Runtime "+execution.runtime_kind,execution.runtime_session_id&&"Session "+execution.runtime_session_id,...(execution.runs||[]).map(run=>run.report?.summary||(run.role||"Run")+" "+run.status)].filter(Boolean).join(" · "));const group=currentGroups.find(row=>row.id===item.task_group_id);document.querySelector("#stop-work").hidden=![\"assigned\",\"running\"].includes(item.actual_status||item.status);document.querySelector("#retry-work").hidden=group?.status===\"paused\"||![\"blocked\",\"failed\"].includes(item.actual_status||item.status);body.scrollTop=scrollTop}
async function openDetail(id){selectedId=id;selectedSnapshot=null;const item=(currentCenter?.work_items||[]).find(row=>row.id===id);if(!item)return;document.querySelector("#detail-title").textContent=taskTitle(item);document.querySelector("#detail-id").textContent=[workLabels[item.status]||item.status,runtimeLabels[item.runtime_kind]||item.runtime_kind,item.runtime_session_id&&"Session "+item.runtime_session_id].filter(Boolean).join(" · ");const dialog=document.querySelector("#detail-dialog");if(!dialog.open)dialog.showModal();document.querySelector("#detail-body").replaceChildren(el("div","skeleton"));try{const snapshot=await api("/api/task-groups/"+encodeURIComponent(item.task_group_id)+"?advanced=1");if(selectedId!==id)return;selectedSnapshot=snapshot;const detailed=(snapshot.work_items||[]).find(row=>row.id===id)||item;renderDetail({...detailed,navigation_thread_id:item.navigation_thread_id},snapshot,0)}catch(error){if(selectedId===id)document.querySelector("#detail-body").replaceChildren(el("div","detail-empty","详情读取失败："+error.message))}}
function closeDetail(){selectedId=null;selectedSnapshot=null;document.querySelector("#detail-dialog").close()}
function renderActivity(rows){const list=document.querySelector("#activity-list");list.replaceChildren();if(!rows.length){list.append(el("div","empty","暂无动态"));return}for(const activity of rows){const row=el("article","activity-row");row.append(el("strong","",activity.work_item_title||"工作项"),el("small","",[activity.at&&new Date(activity.at).toLocaleString("zh-CN"),activity.title||activity.type,activity.text||activity.command||activity.output].filter(Boolean).join(" · ")));list.append(row)}}
function sourceChip(meta,label,value){if(value==null||value==="")return;const full=displayValue(value),chip=el("span","",label+compactValue(value));chip.title=full;meta.append(chip)}
function appendSource(body,source){if(!source?.kind&&!source?.reference&&!source?.fingerprint&&!source?.metadata)return;const meta=el("div","source-meta");sourceChip(meta,"",source.kind);sourceChip(meta,"",source.reference);sourceChip(meta,"指纹 ",source.fingerprint);for(const [key,value] of Object.entries(sourceMetadata(source)))sourceChip(meta,key+"=",value);body.append(meta)}
function renderRequirement(requirement){const card=el("article","demand-card");card.append(el("h3","",requirement.title||requirement.key||"未命名需求"));if(requirement.normalizedRequirement)card.append(el("div","demand-copy",requirement.normalizedRequirement));if(requirement.impactSummary)card.append(el("div","demand-meta","影响："+requirement.impactSummary));if(requirement.acceptanceCriteria?.length)card.append(el("div","demand-meta","验收："+requirement.acceptanceCriteria.map(displayValue).join("；")));if(requirement.workItems?.length)card.append(el("div","demand-work","预计工作项："+requirement.workItems.map(item=>item.title||item.key||displayValue(item)).join("、")));return card}
function renderConfirmations(rows){const panel=document.querySelector("#pending-confirmations"),list=panel.querySelector("[data-confirmation-list]");list.replaceChildren();panel.hidden=!rows.length;for(const pending of rows){const item=el("article","confirmation-item");item.append(el("strong","","需求分析师复述"));appendSource(item,pending.source);if(pending.summary)item.append(el("div","demand-summary",pending.summary));if(pending.proposed_requirements?.length){const requirements=el("div","demand-list");for(const requirement of pending.proposed_requirements)requirements.append(renderRequirement(requirement));item.append(requirements)}if(pending.questions?.length){const questions=el("div","demand-questions");questions.append(el("strong","","确认前缺失信息"));for(const question of pending.questions)questions.append(el("div","","· "+question));item.append(questions)}const button=el("button","button primary","确认并执行");button.type="button";button.addEventListener("click",async()=>{button.disabled=true;try{await api("/api/task-groups/"+encodeURIComponent(pending.task_group_id)+"/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event_key:pending.event_key,approved:true})});showToast("已确认，任务开始执行");await refresh(true)}catch(error){showToast("确认失败："+error.message)}finally{button.disabled=false}});item.append(button);list.append(item)}}
function renderDemandActivity(rows){const panel=document.querySelector("#demand-activity"),body=panel.querySelector("[data-demand-activity]"),replan=rows.find(row=>row.event_type==="project_manager.replanned");body.replaceChildren();panel.hidden=!replan;if(!replan)return;const status=el("article","replan-status");status.append(el("strong","",replan.task_group_title||"项目经理已重排"),el("small","",[replan.created_at&&new Date(replan.created_at).toLocaleString("zh-CN"),replan.payload?.reason,replan.payload?.summary].filter(Boolean).join(" · ")));body.append(status)}
async function deleteWork(){const item=(currentCenter?.work_items||[]).find(row=>row.id===selectedId);if(!item)return;if(!confirm("确定删除此工作项？运行中的 Worker 会先停止，执行会话、Run、Checkpoint、证据与验收记录会永久删除。此操作不可撤销。"))return;try{await api("/api/task-groups/"+encodeURIComponent(item.task_group_id)+"/work-items/"+encodeURIComponent(item.id),{method:"DELETE"});closeDetail();showToast("工作项已删除");await refresh(true)}catch(error){showToast("删除失败："+error.message)}}
async function controlWork(action){const item=(currentCenter?.work_items||[]).find(row=>row.id===selectedId);if(!item)return;const button=document.querySelector(action==="stop"?"#stop-work":"#retry-work");button.disabled=true;try{await api("/api/task-groups/"+encodeURIComponent(item.task_group_id)+"/work-items/"+encodeURIComponent(item.id)+"/"+action,{method:"POST"});showToast(action==="stop"?"已停止当前尝试":"已重新进入执行队列");await refresh(true);await openDetail(item.id)}catch(error){showToast((action==="stop"?"停止失败：":"重试失败：")+error.message)}finally{button.disabled=false}}
async function clearAll(){if(!confirm("确定清空全部任务？所有运行中的 Worker 会先停止，全部任务数据会永久删除。此操作不可撤销。"))return;try{await api("/api/task-groups",{method:"DELETE"});showToast("全部任务已清空");await refresh(true)}catch(error){showToast("清空失败："+error.message)}}
async function refresh(manual=false){if(!token){showAuth();return}document.querySelector("#authorization").hidden=true;document.querySelector("#app").hidden=false;if(manual)setSync("","正在刷新");try{const [response,groupResponse]=await Promise.all([api("/api/task-center"),api("/api/task-groups")]),center=response.task_center;currentCenter=center;currentGroups=groupResponse.task_groups||[];renderMetrics(center);renderRuntimeOverview(currentGroups);renderConfirmations(center.pending_confirmations||[]);renderDemandActivity(center.demand_activity||[]);renderBoard(center.work_items||[]);renderActivity(center.activity||[]);setSync("ok","已同步 "+new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"}));if(selectedId&&document.querySelector("#detail-dialog").open){const scrollTop=document.querySelector("#detail-body").scrollTop,item=(center.work_items||[]).find(row=>row.id===selectedId);if(item&&selectedSnapshot)renderDetail({...item,navigation_thread_id:item.navigation_thread_id},selectedSnapshot,scrollTop);else if(!item)closeDetail()}}catch(error){setSync("error","同步失败");showToast(error.message==="unauthorized"?"授权已失效，请重新运行 9codex taskboard":"刷新失败："+error.message)}}
document.querySelector("#refresh").addEventListener("click",()=>refresh(true));document.querySelector("#clear-all").addEventListener("click",clearAll);document.querySelector("#detail-refresh").addEventListener("click",()=>selectedId&&openDetail(selectedId));document.querySelector("#stop-work").addEventListener("click",()=>controlWork("stop"));document.querySelector("#retry-work").addEventListener("click",()=>controlWork("retry"));document.querySelector("#close-detail").addEventListener("click",closeDetail);document.querySelector("#detail-dialog").addEventListener("close",()=>{selectedId=null;selectedSnapshot=null});document.querySelector("#delete-work").addEventListener("click",deleteWork);
refresh();setInterval(refresh,2000);
</script>
</body></html>`;

export function createTaskboardServer(options) {
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("taskboard must listen on loopback");
  if (typeof options.token !== "string" || options.token.length < 24) {
    throw new Error("taskboard token must contain at least 24 characters");
  }
  const store = options.store;
  const orchestrator = options.orchestrator;

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        });
        response.end(PAGE);
        return;
      }
      if (!authorized(request, options.token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/healthz") {
        sendJson(response, 200, { ok: true, service: "9codex-taskboard" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/task-center") {
        sendJson(response, 200, {
          task_center: buildTaskCenterPayload(store, {
            maxWorkers: options.maxWorkers,
          })[0],
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/task-groups") {
        const taskGroups = await store.listTaskGroups();
        sendJson(response, 200, {
          task_groups: taskGroups.filter((group) => group.status !== "collecting" || group.demand_count !== 0),
        });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/api/task-groups") {
        sendJson(response, 200, await orchestrator.clearTaskGroups());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/demands") {
        const body = await readJson(request);
        if (body.runtime_kind !== undefined && !RUNTIME_KINDS.has(body.runtime_kind)) {
          sendJson(response, 400, { error: "invalid_runtime_kind" });
          return;
        }
        const active = body.source_message_id
          ? null
          : store.resolveActiveConversation?.(body.thread_id || null);
        const threadId = body.thread_id || active?.threadId;
        const sourceMessageId = body.source_message_id || active?.requestId;
        if (!threadId || !sourceMessageId) {
          sendJson(response, 409, { error: "active_conversation_ambiguous" });
          return;
        }
        sendJson(response, 200, await orchestrator.ingestDemand({
          threadId,
          sourceMessageId,
          content: body.content,
          workspace: body.workspace,
          title: body.title,
          runtimeKind: body.runtime_kind,
          source: body.source,
          proposal: body.proposal,
        }));
        return;
      }
      const match = url.pathname.match(/^\/api\/task-groups\/([^/]+)(?:\/(pause|resume|cancel|confirm|runtime))?$/);
      const workItemMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/work-items\/([^/]+)(?:\/(stop|retry))?$/);
      if (workItemMatch && request.method === "DELETE") {
        sendJson(response, 200, {
          deleted: await orchestrator.deleteWorkItem(
            decodeURIComponent(workItemMatch[1]),
            decodeURIComponent(workItemMatch[2]),
          ),
        });
        return;
      }
      if (workItemMatch && workItemMatch[3] && request.method === "POST") {
        const method = workItemMatch[3] === "stop" ? "stopWorkItem" : "retryWorkItem";
        sendJson(response, 200, await orchestrator[method](
          decodeURIComponent(workItemMatch[1]),
          decodeURIComponent(workItemMatch[2]),
        ));
        return;
      }
      if (match && request.method === "DELETE" && !match[2]) {
        sendJson(response, 200, await orchestrator.deleteTaskGroup(decodeURIComponent(match[1])));
        return;
      }
      if (match && request.method === "GET" && !match[2]) {
        const snapshot = await store.getTaskGroupSnapshot(decodeURIComponent(match[1]), {
          includeWorkers: true,
        });
        if (snapshot) snapshot.work_items = enrichWorkItems(snapshot);
        if (snapshot && url.searchParams.get("advanced") !== "1") {
          delete snapshot.worker_sessions;
          delete snapshot.runs;
          delete snapshot.checkpoints;
        }
        if (!snapshot) sendJson(response, 404, { error: "not_found" });
        else sendJson(response, 200, snapshot);
        return;
      }
      if (match && request.method === "POST" && match[2]) {
        const body = await readJson(request);
        if (match[2] === "runtime") {
          if (!RUNTIME_KINDS.has(body.runtime_kind)) {
            sendJson(response, 400, { error: "invalid_runtime_kind" });
            return;
          }
          sendJson(response, 200, await store.changeTaskGroupRuntime(
            decodeURIComponent(match[1]),
            {
              runtimeKind: body.runtime_kind,
              actor: "user",
              source: "taskboard",
              reason: body.reason,
            },
          ));
          return;
        }
        if (match[2] === "confirm") {
          const taskGroupId = decodeURIComponent(match[1]);
          const snapshot = await store.getTaskGroupSnapshot(taskGroupId);
          const event = (snapshot?.demand_events || []).find((row) => row.event_key === body.event_key);
          if (!event) {
            sendJson(response, 404, { error: "pending_confirmation_not_found" });
            return;
          }
          sendJson(response, 200, await orchestrator.confirmDemand({
            eventKey: event.event_key,
            approved: body.approved !== false,
            approvalSourceMessageId: body.source_message_id || `taskboard:${crypto.randomUUID()}`,
          }));
          return;
        }
        const handler = orchestrator[`${match[2]}TaskGroup`] || orchestrator[match[2]];
        if (typeof handler !== "function") throw new Error(`orchestrator cannot ${match[2]} task group`);
        const result = await handler.call(orchestrator, decodeURIComponent(match[1]), {
          actor: body.actor || "user",
          reason: body.reason || null,
        });
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const statusCode = error.statusCode || {
        invalid_runtime_kind: 400,
        not_found: 404,
        runtime_switch_blocked: 409,
      }[error.code] || 500;
      sendJson(response, statusCode, {
        error: error.statusCode
          ? error.message
          : statusCode === 500 ? "internal_error" : error.code,
      });
      options.onError?.(error);
    }
  });
}

export async function startTaskboard(options) {
  const server = createTaskboardServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port || 10102, options.host || "127.0.0.1", resolve);
  });
  return server;
}
