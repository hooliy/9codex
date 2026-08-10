import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";

import { loadConfig } from "./config.mjs";
import {
  createAuthorization,
  exchangeAuthorizationCode,
  syncBootstrap,
} from "./control-plane.mjs";

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function openBrowserDefault(url) {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

export async function startLoopbackCallback(expectedState, timeoutMs = 600_000) {
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || state !== expectedState) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("9codex authorization failed: invalid callback state.");
      rejectCode(new Error("Invalid authorization callback state"));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("9codex authorization succeeded. You can close this window.");
    resolveCode({ code, state });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timer = setTimeout(() => rejectCode(new Error("Authorization callback timed out")), timeoutMs);
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${server.address().port}/callback`,
    waitForCode: () => codePromise,
    close: () => new Promise((resolve) => {
      clearTimeout(timer);
      server.close(resolve);
    }),
  };
}

export async function runInitFlow(paths, controlPlaneUrl, options = {}) {
  const config = options.config || loadConfig(paths);
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const state = options.state || base64Url(crypto.randomBytes(18));
  const callback = await (options.startCallbackServer || startLoopbackCallback)(state);
  try {
    const authorization = await createAuthorization(controlPlaneUrl, {
      client: "9codex-cli",
      client_version: options.version || "3.0.0",
      installation_id: config.installation.installation_id,
      device_name: config.installation.device_name || os.hostname(),
      platform: options.platform || process.platform,
      redirect_uri: callback.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }, options);
    await (options.openBrowser || openBrowserDefault)(authorization.authorization_url);
    const callbackResult = await callback.waitForCode();
    if (callbackResult.state !== state) throw new Error("Invalid authorization callback state");
    const tokens = await exchangeAuthorizationCode(controlPlaneUrl, {
      request_id: authorization.request_id,
      authorization_code: callbackResult.code,
      code_verifier: verifier,
      installation_id: config.installation.installation_id,
    }, options);
    config.control_plane = {
      ...config.control_plane,
      base_url: controlPlaneUrl.replace(/\/$/, ""),
      authorization_id: tokens.authorization_id,
      access_token: tokens.access_token,
      access_token_expires_at: new Date(
        Date.now() + Number(tokens.access_token_expires_in || 3600) * 1000,
      ).toISOString(),
      refresh_token: tokens.refresh_token,
      events_enabled: true,
    };
    const result = await syncBootstrap(paths, config, options);
    return result.config;
  } finally {
    await callback.close();
  }
}
