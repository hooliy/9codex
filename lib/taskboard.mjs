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
<title>9codex Taskboard</title>
<style>
:root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;background:#111827;color:#e5e7eb}
body{margin:0;max-width:1200px;padding:24px;margin:auto}h1{margin:0 0 18px}
button{font:inherit;padding:6px 10px}article{border:1px solid #374151;border-radius:10px;padding:14px;margin:10px 0;background:#1f2937}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.muted{color:#9ca3af}.blocked{color:#fca5a5}
progress{width:180px}.hidden{display:none}pre{white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body>
<div class="row"><h1>9codex Taskboard</h1><span id="status" class="muted"></span></div>
<main id="groups"></main>
<template id="group"><article><div class="row"><strong data-title></strong><code data-status></code></div>
<div class="row"><progress max="100" data-progress></progress><span data-stage></span><span data-workers></span><span data-blockers></span></div>
<div class="muted" data-updated></div><details><summary>详情</summary><pre data-detail>加载中</pre></details></article></template>
<script>
const token=new URLSearchParams(location.hash.slice(1)).get("token")||sessionStorage.token||"";
if(token)sessionStorage.token=token;
const headers={authorization:"Bearer "+token};
const esc=v=>v==null?"":String(v);
async function api(path,options={}){const r=await fetch(path,{...options,headers:{...headers,...options.headers}});if(!r.ok)throw new Error(await r.text());return r.json()}
const lines=(title,rows,render)=>[title,...(rows.length?rows.map(render):["  无"]),""];function formatDetail(x){const revisions=x.requirement_revisions||[],items=x.work_items||[],evidence=x.evidence||[],acceptances=x.acceptances||[];
return [
"任务目标",...(revisions.filter(r=>r.status==="active").map(r=>"  "+r.normalized_requirement)||[]),"",
"最新需求版本",...(revisions.filter(r=>r.status==="active").map(r=>"  revision "+r.revision+" · "+r.impact_summary)||[]),"",
...lines("需求变更时间线",x.demand_events||[],r=>"  "+r.received_at+" · "+r.classified_type+" · "+r.raw_content),
...lines("当前执行计划 / DAG",items,r=>"  "+r.id+" · "+r.status+" · "+r.title),
...lines("运行中事项",items.filter(r=>["assigned","running"].includes(r.status)),r=>"  "+r.id+" · "+r.title),
...lines("等待验收事项",items.filter(r=>["reported","verifying"].includes(r.status)),r=>"  "+r.id+" · "+r.title),
...lines("已完成事项",items.filter(r=>r.status==="closed"),r=>"  "+r.id+" · "+r.title),
...lines("阻断事项",items.filter(r=>r.status==="blocked"),r=>"  "+r.id+" · "+r.title),
...lines("测试与构建证据",evidence,r=>"  "+r.type+" · "+(r.exit_code??"n/a")+" · "+(r.output_path||r.content_hash||r.id)),
...lines("验收结果",acceptances,r=>"  "+r.scope+" · "+r.result+" · "+r.scope_id),
"最终验收报告","  "+(x.status==="done"?"通过":"尚未完成")
].join("\\n")}
async function detail(id,node){try{node.textContent=formatDetail(await api("/api/task-groups/"+encodeURIComponent(id)))}catch(e){node.textContent=e.message}}
async function refresh(){try{const rows=await api("/api/task-groups");const root=document.querySelector("#groups");root.replaceChildren();
for(const row of rows.task_groups){const node=document.querySelector("#group").content.cloneNode(true);node.querySelector("[data-title]").textContent=esc(row.title||row.id);
node.querySelector("[data-status]").textContent=esc(row.status);node.querySelector("[data-progress]").value=Number(row.progress||0);
node.querySelector("[data-stage]").textContent="阶段 "+esc(row.current_stage||row.status);node.querySelector("[data-workers]").textContent="成员 "+Number(row.running_workers||0);
const blockers=node.querySelector("[data-blockers]");blockers.textContent="阻断 "+Number(row.blocker_count||0);if(row.blocker_count)blockers.className="blocked";
node.querySelector("[data-updated]").textContent="更新 "+esc(row.updated_at);const details=node.querySelector("details");details.addEventListener("toggle",()=>{if(details.open)detail(row.id,node.querySelector("[data-detail]"))},{once:true});root.append(node)}
document.querySelector("#status").textContent="已同步 "+new Date().toLocaleTimeString()}catch(e){document.querySelector("#status").textContent="错误 "+e.message}}
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
        sendJson(response, 200, { task_groups: await store.listTaskGroups() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/demands") {
        const body = await readJson(request);
        const active = body.thread_id && body.source_message_id
          ? null
          : store.resolveActiveConversation?.();
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
