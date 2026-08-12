import http from "node:http";
import crypto from "node:crypto";

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
.summary{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px;margin-bottom:20px}
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
      </div>
    </div>
  </header>
  <main class="content">
    <section class="summary" aria-label="任务概览">
      <div class="metric"><div class="metric-label">全部任务</div><div class="metric-value" data-metric="all">0</div></div>
      <div class="metric" data-tone="active"><div class="metric-label">进行中</div><div class="metric-value" data-metric="running">0</div></div>
      <div class="metric" data-tone="warning"><div class="metric-label">待确认</div><div class="metric-value" data-metric="confirm">0</div></div>
      <div class="metric" data-tone="danger"><div class="metric-label">已阻断</div><div class="metric-value" data-metric="blocked">0</div></div>
      <div class="metric" data-tone="success"><div class="metric-label">已完成</div><div class="metric-value" data-metric="done">0</div></div>
    </section>
    <section id="board" class="board" aria-label="任务看板">
      <section class="column" data-column="confirm"><div class="column-head"><h2 class="column-title">待确认</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
      <section class="column" data-column="running"><div class="column-head"><h2 class="column-title">进行中</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
      <section class="column" data-column="review"><div class="column-head"><h2 class="column-title">验收中</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
      <section class="column" data-column="terminal"><div class="column-head"><h2 class="column-title">已完成 / 阻断</h2><span class="count" data-count>0</span></div><div class="column-body" data-list><div class="skeleton"></div></div></section>
    </section>
  </main>
</div>
<dialog id="detail-dialog" aria-labelledby="detail-title">
  <div class="drawer">
    <header class="drawer-head"><div class="drawer-title"><h2 id="detail-title">任务详情</h2><div id="detail-id" class="drawer-subtitle"></div></div><button id="close-detail" class="icon-button" type="button" aria-label="关闭详情">×</button></header>
    <div id="detail-body" class="drawer-body" role="region" tabindex="0" aria-label="任务详细信息"><div class="skeleton"></div></div>
    <footer class="drawer-actions">
      <button id="detail-refresh" class="button" type="button">刷新详情</button>
      <button id="pause" class="button" type="button">暂停</button>
      <button id="resume" class="button primary" type="button">恢复</button>
      <button id="cancel" class="button danger" type="button">取消任务</button>
    </footer>
  </div>
</dialog>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<template id="task-card"><button class="task-card" type="button"><span class="status-rail" aria-hidden="true"></span><span class="card-top"><span class="card-title" data-title></span><span class="status-badge" data-status></span></span><span class="progress-row"><span class="progress-track"><span class="progress-fill" data-progress></span></span><span class="progress-value" data-progress-label></span></span><span class="card-meta"><span data-stage></span><span data-workers></span><span data-blockers></span><span data-updated></span></span></button></template>
<script>
const token=new URLSearchParams(location.hash.slice(1)).get("token")||sessionStorage.token||"";
if(token){sessionStorage.token=token;if(location.hash)history.replaceState(null,"",location.pathname+location.search)}
const headers={authorization:"Bearer "+token};
const expanded=new Set();
const esc=v=>v==null?"":String(v);
const labels={collecting:"收集中",awaiting_confirmation:"待确认",planning:"规划中",executing:"执行中",integrating:"集成中",verifying:"验收中",awaiting_user:"等待用户",done:"已完成",blocked:"已阻断",paused:"已暂停",canceled:"已取消"};
const workLabels={backlog:"待规划",ready:"就绪",assigned:"已分配",running:"进行中",reported:"已提交",verifying:"验收中",failed:"失败",rework:"返工",passed:"已通过",closed:"已完成",stale:"已过期",blocked:"已阻断",canceled:"已取消",revalidate:"重新验收"};
const columnFor=status=>["collecting","awaiting_confirmation","planning","awaiting_user"].includes(status)?"confirm":["executing","paused"].includes(status)?"running":["integrating","verifying"].includes(status)?"review":"terminal";
const toneFor=status=>["done","closed","passed"].includes(status)?"success":["blocked","failed","canceled"].includes(status)?"danger":["collecting","awaiting_confirmation","planning","awaiting_user","paused"].includes(status)?"warning":"active";
const taskTitle=row=>{const value=String(row.title??"").trim();return !value||value===String(row.id??"")?"未命名任务":/^Codex task(?:\\s+.*)?$/i.test(value)?"Codex 会话任务":value};
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=esc(text);return node};
const relativeTime=value=>{const time=Date.parse(value);if(!Number.isFinite(time))return "时间未知";const seconds=Math.round((time-Date.now())/1000);const unit=Math.abs(seconds)<60?"second":Math.abs(seconds)<3600?"minute":Math.abs(seconds)<86400?"hour":"day";const divisor={second:1,minute:60,hour:3600,day:86400}[unit];return new Intl.RelativeTimeFormat("zh-CN",{numeric:"auto"}).format(Math.round(seconds/divisor),unit)};
let currentRows=[],selectedId=null,toastTimer,detailRequest=0;
async function api(path,options={}){const r=await fetch(path,{...options,headers:{...headers,...options.headers}});if(!r.ok){let message="请求失败";try{const body=await r.json();message=body.error||message}catch{}throw new Error(message)}return r.json()}
function showAuth(){document.querySelector("#authorization").hidden=false;document.querySelector("#app").hidden=true}
function showToast(message){const node=document.querySelector("#toast");node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,3200)}
function setSync(kind,text){const sync=document.querySelector("#sync");sync.className="sync "+kind;document.querySelector("#status").textContent=text}
function renderMetrics(rows){const counts={all:rows.length,running:rows.filter(r=>["executing","integrating","verifying"].includes(r.status)).length,confirm:rows.filter(r=>["collecting","awaiting_confirmation","planning","awaiting_user"].includes(r.status)).length,blocked:rows.filter(r=>r.status==="blocked").length,done:rows.filter(r=>r.status==="done").length};for(const [key,value] of Object.entries(counts))document.querySelector('[data-metric="'+key+'"]').textContent=value;document.querySelector("#task-total").textContent=rows.length+" 个会话任务"}
function renderCard(row){const node=document.querySelector("#task-card").content.firstElementChild.cloneNode(true);const progress=Math.max(0,Math.min(100,Number(row.progress||0))),title=taskTitle(row);node.dataset.tone=toneFor(row.status);node.setAttribute("aria-label",title+"，"+(labels[row.status]||"状态未知")+"，进度 "+progress+"%");
node.querySelector("[data-title]").textContent=title;node.querySelector("[data-status]").textContent=labels[row.status]||"状态未知";node.querySelector("[data-progress]").style.width=progress+"%";node.querySelector("[data-progress-label]").textContent=progress+"%";
node.querySelector("[data-stage]").textContent="阶段 · "+(labels[row.current_stage]||labels[row.status]||"未知");node.querySelector("[data-workers]").textContent="运行成员 · "+Number(row.running_workers||0);node.querySelector("[data-blockers]").textContent="阻断 · "+Number(row.blocker_count||0);node.querySelector("[data-updated]").textContent=relativeTime(row.updated_at);
node.addEventListener("click",()=>openDetail(row.id));return node}
function renderBoard(rows){for(const column of document.querySelectorAll("[data-column]")){const key=column.dataset.column;const matches=rows.filter(row=>columnFor(row.status)===key);const list=column.querySelector("[data-list]");list.replaceChildren();column.querySelector("[data-count]").textContent=matches.length;if(matches.length)for(const row of matches)list.append(renderCard(row));else list.append(el("div","empty","暂无任务"))}}
function itemText(row){return row.title||row.normalized_requirement||row.raw_content||row.impact_summary||row.output_path||row.content_hash||row.id||"未命名记录"}
function detailSection(title,rows,meta){const section=el("section","detail-section");section.append(el("h3","",title));if(!rows.length){section.append(el("div","detail-empty","暂无记录"));return section}const list=el("ul","detail-list");for(const row of rows){const item=el("li","detail-item",itemText(row));const detail=meta(row);if(detail)item.append(el("small","",detail));list.append(item)}section.append(list);return section}
function renderDetail(x,scrollTop=0){const body=document.querySelector("#detail-body"),revisions=x.requirement_revisions||[],items=x.work_items||[],evidence=x.evidence||[],acceptances=x.acceptances||[],active=revisions.filter(r=>r.status==="active"),progress=Math.max(0,Math.min(100,Number(x.progress||currentRows.find(r=>r.id===x.id)?.progress||0)));body.replaceChildren();
const status=el("div","detail-status");const statusText=el("div");statusText.append(el("strong","",labels[x.status]||"状态未知"));const track=el("div","progress-track detail-progress"),fill=el("div","progress-fill");fill.style.width=progress+"%";track.append(fill);statusText.append(track);status.append(statusText,el("strong","",progress+"%"));body.append(status);
body.append(detailSection("任务目标",active,r=>"需求版本 "+esc(r.revision||"—")));
body.append(detailSection("最新需求版本",active.slice(-1),r=>"影响："+esc(r.impact_summary||"未说明")));
body.append(detailSection("需求变更时间线",x.demand_events||[],r=>esc(r.received_at||"")+" · "+esc(r.classified_type||"需求")));
body.append(detailSection("当前执行计划 / DAG",items,r=>(workLabels[r.status]||r.status||"状态未知")+" · "+esc(r.id||"")));
body.append(detailSection("运行中事项",items.filter(r=>["assigned","running"].includes(r.status)),r=>(workLabels[r.status]||r.status||"")+" · "+esc(r.id||"")));
body.append(detailSection("等待验收事项",items.filter(r=>["reported","verifying"].includes(r.status)),r=>(workLabels[r.status]||r.status||"")+" · "+esc(r.id||"")));
body.append(detailSection("已完成事项",items.filter(r=>["passed","closed"].includes(r.status)),r=>(workLabels[r.status]||r.status||"")+" · "+esc(r.id||"")));
body.append(detailSection("阻断事项",items.filter(r=>["blocked","failed"].includes(r.status)),r=>(workLabels[r.status]||r.status||"")+" · "+esc(r.id||"")));
body.append(detailSection("测试与构建证据",evidence,r=>esc(r.type||"证据")+" · 退出码 "+esc(r.exit_code??"—")));
body.append(detailSection("验收结果",acceptances,r=>esc(r.scope||"范围")+" · "+esc(r.result||"待定")));
body.append(detailSection("最终验收报告",[{title:x.status==="done"?"验收通过":"尚未完成最终验收"}],()=>x.status==="done"?"任务已完成":"任务仍在推进"));
body.scrollTop=scrollTop;updateActions(x.status)}
function updateActions(status){const terminal=["done","canceled"].includes(status);document.querySelector("#pause").hidden=!["executing","integrating","verifying"].includes(status);document.querySelector("#resume").hidden=!["paused","blocked"].includes(status);document.querySelector("#cancel").hidden=terminal}
async function loadDetail(id,{initial=false,preserve=true}={}){const body=document.querySelector("#detail-body"),scrollTop=preserve?body.scrollTop:0,request=++detailRequest;if(initial)body.replaceChildren(el("div","skeleton"));try{const snapshot=await api("/api/task-groups/"+encodeURIComponent(id));if(request!==detailRequest||selectedId!==id)return;renderDetail(snapshot,scrollTop)}catch(error){if(request!==detailRequest||selectedId!==id)return;if(initial)body.replaceChildren(el("div","detail-empty","详情加载失败："+error.message));showToast("详情加载失败："+error.message)}}
async function openDetail(id){selectedId=id;expanded.clear();expanded.add(id);const row=currentRows.find(item=>item.id===id)||{};document.querySelector("#detail-title").textContent=taskTitle(row);document.querySelector("#detail-id").textContent=esc(id);const dialog=document.querySelector("#detail-dialog");if(!dialog.open)dialog.showModal();await loadDetail(id,{initial:true,preserve:false})}
function closeDetail(){expanded.clear();selectedId=null;document.querySelector("#detail-dialog").close()}
async function control(action){if(!selectedId)return;if(action==="cancel"&&!confirm("确定取消这个任务？此操作会停止其未完成工作项。"))return;for(const button of document.querySelectorAll(".drawer-actions button"))button.disabled=true;try{await api("/api/task-groups/"+encodeURIComponent(selectedId)+"/"+action,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reason:"taskboard_user_action"})});showToast(action==="pause"?"任务已暂停":action==="resume"?"任务已恢复":"任务已取消");await refresh(true)}catch(error){showToast("操作失败："+error.message)}finally{for(const button of document.querySelectorAll(".drawer-actions button"))button.disabled=false}}
async function refresh(manual=false){if(!token){showAuth();return}document.querySelector("#authorization").hidden=true;document.querySelector("#app").hidden=false;if(manual)setSync("","正在刷新");try{const rows=await api("/api/task-groups");currentRows=rows.task_groups||[];renderMetrics(currentRows);renderBoard(currentRows);setSync("ok","已同步 "+new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"}));if(selectedId&&expanded.has(selectedId)&&document.querySelector("#detail-dialog").open)await loadDetail(selectedId,{preserve:true})}catch(error){setSync("error","同步失败");showToast(error.message==="unauthorized"?"授权已失效，请重新运行 9codex taskboard":"刷新失败："+error.message)}}
document.querySelector("#refresh").addEventListener("click",()=>refresh(true));document.querySelector("#detail-refresh").addEventListener("click",()=>selectedId&&loadDetail(selectedId,{preserve:true}));document.querySelector("#close-detail").addEventListener("click",closeDetail);document.querySelector("#detail-dialog").addEventListener("close",()=>{detailRequest++;expanded.clear();selectedId=null});document.querySelector("#pause").addEventListener("click",()=>control("pause"));document.querySelector("#resume").addEventListener("click",()=>control("resume"));document.querySelector("#cancel").addEventListener("click",()=>control("cancel"));
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
      if (request.method === "GET" && url.pathname === "/api/task-groups") {
        const taskGroups = await store.listTaskGroups();
        sendJson(response, 200, {
          task_groups: taskGroups.filter((group) => group.status !== "collecting" || group.demand_count !== 0),
        });
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
      const match = url.pathname.match(/^\/api\/task-groups\/([^/]+)(?:\/(pause|resume|cancel))?$/);
      if (match && request.method === "GET" && !match[2]) {
        const snapshot = await store.getTaskGroupSnapshot(decodeURIComponent(match[1]), {
          includeWorkers: url.searchParams.get("advanced") === "1",
        });
        if (!snapshot) sendJson(response, 404, { error: "not_found" });
        else sendJson(response, 200, snapshot);
        return;
      }
      if (match && request.method === "POST" && match[2]) {
        const body = await readJson(request);
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
