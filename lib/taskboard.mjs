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
.confirmation-item{display:grid;gap:8px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2)}
.confirmation-item+.confirmation-item{margin-top:8px}
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
.drawer-actions{padding:12px 19px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)}
.toast{position:fixed;z-index:30;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:10px 13px;border:1px solid var(--border-strong);border-radius:9px;background:var(--text);color:var(--bg);box-shadow:var(--shadow);font-size:12px}
.muted{color:var(--muted)}
@keyframes shimmer{to{background-position-x:-220%}}
@media(max-width:1100px){.board{grid-template-columns:repeat(2,minmax(260px,1fr))}.summary{grid-template-columns:repeat(3,1fr)}}
@media(max-width:640px){
  .topbar-inner,.content{padding-left:14px;padding-right:14px}.topbar-inner{align-items:flex-start}.header-meta{justify-content:flex-end}
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
    <section id="pending-confirmations" class="confirmation-panel" aria-label="待确认事项" hidden><h2>特殊情况待确认</h2><div data-confirmation-list></div></section>
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
      <button id="delete-work" class="button danger" type="button">删除此工作项</button>
    </footer>
  </div>
</dialog>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<template id="task-card"><button class="task-card" type="button"><span class="status-rail" aria-hidden="true"></span><span class="card-top"><span class="card-title" data-title></span><span class="status-badge" data-status></span></span><span class="progress-row"><span class="progress-track"><span class="progress-fill" data-progress></span></span><span class="progress-value" data-progress-label></span></span><span class="card-meta"><span data-stage></span><span data-workers></span><span data-blockers></span><span data-updated></span></span></button></template>
<script>
const token=new URLSearchParams(location.hash.slice(1)).get("token")||sessionStorage.token||"";
if(token){sessionStorage.token=token;if(location.hash)history.replaceState(null,"",location.pathname+location.search)}
const headers={authorization:"Bearer "+token};
const esc=v=>v==null?"":String(v);
const workLabels={backlog:"待规划",ready:"就绪",assigned:"已分配",running:"进行中",reported:"已提交",verifying:"验收中",failed:"失败",rework:"待返工",passed:"已通过",closed:"已完成",stale:"已过期",blocked:"已阻断",canceled:"已取消",revalidate:"重新验收"};
const columnFor=status=>["backlog","ready","rework"].includes(status)?"pending":["assigned","running"].includes(status)?"running":["reported","verifying","revalidate"].includes(status)?"review":"terminal";
const toneFor=status=>["closed","passed"].includes(status)?"success":["blocked","failed","canceled"].includes(status)?"danger":["backlog","ready","stale"].includes(status)?"warning":"active";
const taskTitle=row=>{const value=String(row.title??"").trim();return !value||value===String(row.id??"")?"未命名工作项":value};
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=esc(text);return node};
const relativeTime=value=>{const time=Date.parse(value);if(!Number.isFinite(time))return "时间未知";const seconds=Math.round((time-Date.now())/1000);const unit=Math.abs(seconds)<60?"second":Math.abs(seconds)<3600?"minute":Math.abs(seconds)<86400?"hour":"day";const divisor={second:1,minute:60,hour:3600,day:86400}[unit];return new Intl.RelativeTimeFormat("zh-CN",{numeric:"auto"}).format(Math.round(seconds/divisor),unit)};
let currentCenter=null,selectedId=null,toastTimer;
async function api(path,options={}){const r=await fetch(path,{...options,headers:{...headers,...options.headers}});if(!r.ok){let message="请求失败";try{const body=await r.json();message=body.error||message}catch{}throw new Error(message)}return r.json()}
function showAuth(){document.querySelector("#authorization").hidden=false;document.querySelector("#app").hidden=true}
function showToast(message){const node=document.querySelector("#toast");node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,3200)}
function setSync(kind,text){const sync=document.querySelector("#sync");sync.className="sync "+kind;document.querySelector("#status").textContent=text}
function renderMetrics(center){const counts=center.counts||{};for(const [key,value] of Object.entries({pending:counts.pending||0,running:counts.running||0,verifying:counts.verifying||0,done:counts.done||0,failed:counts.failed||0,workers:Number(center.running_workers||0)+" / "+Number(center.max_workers||0)}))document.querySelector('[data-metric="'+key+'"]').textContent=value;document.querySelector("#task-total").textContent=(center.work_items||[]).length+" 个工作项 · 总体进度 "+Number(center.progress||0)+"%"}
function renderCard(row){const node=document.querySelector("#task-card").content.firstElementChild.cloneNode(true);const progress=Math.max(0,Math.min(100,Number(row.progress||0))),title=taskTitle(row);node.dataset.tone=toneFor(row.status);node.setAttribute("aria-label",title+"，"+(workLabels[row.status]||"状态未知")+"，进度 "+progress+"%");
node.querySelector("[data-title]").textContent=title;node.querySelector("[data-status]").textContent=workLabels[row.status]||"状态未知";node.querySelector("[data-progress]").style.width=progress+"%";node.querySelector("[data-progress-label]").textContent=progress+"%";
node.querySelector("[data-stage]").textContent=[row.queue_position&&"排队 "+row.queue_position,row.waiting_reason||workLabels[row.status]||"状态未知"].filter(Boolean).join(" · ");node.querySelector("[data-workers]").textContent=row.owner||"未分配";node.querySelector("[data-blockers]").textContent=row.next_action||"";node.querySelector("[data-updated]").textContent=relativeTime(row.last_activity_at||row.updated_at);
node.addEventListener("click",()=>openDetail(row.id));return node}
function renderBoard(rows){for(const column of document.querySelectorAll("[data-column]")){const key=column.dataset.column;const matches=rows.filter(row=>columnFor(row.status)===key);const list=column.querySelector("[data-list]");list.replaceChildren();column.querySelector("[data-count]").textContent=matches.length;if(matches.length)for(const row of matches)list.append(renderCard(row));else list.append(el("div","empty","暂无任务"))}}
function detailRow(body,label,value){if(value==null||value==="")return;const row=el("div","detail-item");row.append(el("strong","",label),el("small","",typeof value==="string"?value:JSON.stringify(value,null,2)));body.append(row)}
function renderDetail(item,scrollTop=0){const body=document.querySelector("#detail-body"),progress=Math.max(0,Math.min(100,Number(item.progress||0)));body.replaceChildren();const status=el("div","detail-status");const statusText=el("div");statusText.append(el("strong","",workLabels[item.status]||"状态未知"));const track=el("div","progress-track detail-progress"),fill=el("div","progress-fill");fill.style.width=progress+"%";track.append(fill);statusText.append(track);status.append(statusText,el("strong","",progress+"%"));body.append(status);
detailRow(body,"当前原因",item.waiting_reason||item.status_reason);detailRow(body,"下一动作",item.next_action);detailRow(body,"执行者",item.owner);detailRow(body,"当前输出摘要",item.output_summary);detailRow(body,"Checkpoint",item.checkpoint);detailRow(body,"验收",item.acceptance_result);detailRow(body,"最近活动",item.last_activity_at);
body.append(el("h3","detail-section","会话实时输出"));const visible=(item.activity||[]).filter(row=>row.text||row.command||row.output||row.files);if(!visible.length)body.append(el("div","detail-empty","当前会话尚未产生可展示输出"));for(const activity of visible){const block=el("article","detail-item");block.append(el("strong","",activity.title||activity.type||"Worker 输出"));if(activity.at)block.append(el("small","",new Date(activity.at).toLocaleString("zh-CN")));if(activity.text)block.append(el("pre","",activity.text));if(activity.command)block.append(el("pre","","$ "+activity.command));if(activity.output)block.append(el("pre","",activity.output));if(activity.files)block.append(el("pre","","文件："+JSON.stringify(activity.files,null,2)));body.append(block)}
body.append(el("h3","detail-section","历史尝试"));if(!item.execution_history?.length)body.append(el("div","detail-empty","暂无历史尝试"));for(const execution of item.execution_history||[])detailRow(body,execution.role==="reviewer"?"审查 AI":execution.role==="integrator"?"集成 AI":"执行 AI",[execution.status,...(execution.runs||[]).map(run=>run.report?.summary||(run.role||"Run")+" "+run.status)].filter(Boolean).join(" · "));body.scrollTop=scrollTop}
function openDetail(id){selectedId=id;const item=(currentCenter?.work_items||[]).find(row=>row.id===id);if(!item)return;document.querySelector("#detail-title").textContent=taskTitle(item);document.querySelector("#detail-id").textContent=workLabels[item.status]||item.status;const dialog=document.querySelector("#detail-dialog");if(!dialog.open)dialog.showModal();renderDetail(item,0)}
function closeDetail(){selectedId=null;document.querySelector("#detail-dialog").close()}
function renderActivity(rows){const list=document.querySelector("#activity-list");list.replaceChildren();if(!rows.length){list.append(el("div","empty","暂无动态"));return}for(const activity of rows){const row=el("article","activity-row");row.append(el("strong","",activity.work_item_title||"工作项"),el("small","",[activity.at&&new Date(activity.at).toLocaleString("zh-CN"),activity.title||activity.type,activity.text||activity.command||activity.output].filter(Boolean).join(" · ")));list.append(row)}}
function renderConfirmations(rows){const panel=document.querySelector("#pending-confirmations"),list=panel.querySelector("[data-confirmation-list]");list.replaceChildren();panel.hidden=!rows.length;for(const pending of rows){const item=el("article","confirmation-item");item.append(el("strong","",pending.proposed_requirement?.normalizedRequirement||pending.proposed_requirement?.title||"待确认方案"));for(const work of pending.proposed_work_items||[])item.append(el("div","", "· "+(work.title||work.key)));const button=el("button","button primary","确认并执行");button.type="button";button.addEventListener("click",async()=>{button.disabled=true;try{await api("/api/task-groups/"+encodeURIComponent(pending.task_group_id)+"/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event_key:pending.event_key,approved:true})});showToast("已确认，任务开始执行");await refresh(true)}catch(error){showToast("确认失败："+error.message)}finally{button.disabled=false}});item.append(button);list.append(item)}}
async function deleteWork(){const item=(currentCenter?.work_items||[]).find(row=>row.id===selectedId);if(!item)return;if(!confirm("确定删除此工作项？运行中的 Worker 会先停止，执行会话、Run、Checkpoint、证据与验收记录会永久删除。此操作不可撤销。"))return;try{await api("/api/task-groups/"+encodeURIComponent(item.task_group_id)+"/work-items/"+encodeURIComponent(item.id),{method:"DELETE"});closeDetail();showToast("工作项已删除");await refresh(true)}catch(error){showToast("删除失败："+error.message)}}
async function clearAll(){if(!confirm("确定清空全部任务？所有运行中的 Worker 会先停止，全部任务数据会永久删除。此操作不可撤销。"))return;try{await api("/api/task-groups",{method:"DELETE"});showToast("全部任务已清空");await refresh(true)}catch(error){showToast("清空失败："+error.message)}}
async function refresh(manual=false){if(!token){showAuth();return}document.querySelector("#authorization").hidden=true;document.querySelector("#app").hidden=false;if(manual)setSync("","正在刷新");try{const response=await api("/api/task-center"),center=response.task_center;currentCenter=center;renderMetrics(center);renderConfirmations(center.pending_confirmations||[]);renderBoard(center.work_items||[]);renderActivity(center.activity||[]);setSync("ok","已同步 "+new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"}));if(selectedId&&document.querySelector("#detail-dialog").open){const scrollTop=document.querySelector("#detail-body").scrollTop,item=(center.work_items||[]).find(row=>row.id===selectedId);if(item)renderDetail(item,scrollTop);else closeDetail()}}catch(error){setSync("error","同步失败");showToast(error.message==="unauthorized"?"授权已失效，请重新运行 9codex taskboard":"刷新失败："+error.message)}}
document.querySelector("#refresh").addEventListener("click",()=>refresh(true));document.querySelector("#clear-all").addEventListener("click",clearAll);document.querySelector("#detail-refresh").addEventListener("click",()=>selectedId&&openDetail(selectedId));document.querySelector("#close-detail").addEventListener("click",closeDetail);document.querySelector("#detail-dialog").addEventListener("close",()=>{selectedId=null});document.querySelector("#delete-work").addEventListener("click",deleteWork);
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
        }));
        return;
      }
      const match = url.pathname.match(/^\/api\/task-groups\/([^/]+)(?:\/(pause|resume|cancel|confirm))?$/);
      const workItemMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/work-items\/([^/]+)$/);
      if (workItemMatch && request.method === "DELETE") {
        sendJson(response, 200, {
          deleted: await orchestrator.deleteWorkItem(
            decodeURIComponent(workItemMatch[1]),
            decodeURIComponent(workItemMatch[2]),
          ),
        });
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
      sendJson(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : "internal_error",
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
