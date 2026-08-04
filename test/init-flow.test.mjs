import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runInitFlow } from "../lib/init-flow.mjs";
import { defaultConfig, saveConfigAtomic } from "../lib/config.mjs";
import { resolvePaths } from "../lib/paths.mjs";

test("opens the login page, exchanges the callback, and saves the authorized bootstrap", async (t) => {
  let authorizationBody;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/cli/authorizations") {
      authorizationBody = body;
      res.end(JSON.stringify({
        request_id: "req_init",
        authorization_url: "https://login.example/authorize/req_init",
        expires_in: 600,
      }));
    } else if (req.url === "/v1/cli/tokens") {
      assert.equal(body.authorization_code, "code_init");
      assert.equal(body.code_verifier.length >= 43, true);
      res.end(JSON.stringify({
        authorization_id: "auth_init",
        access_token: "access_init",
        access_token_expires_in: 3600,
        refresh_token: "refresh_init",
        refresh_token_expires_at: null,
      }));
    } else if (req.url === "/v1/agent/bootstrap") {
      res.end(JSON.stringify({
        revision: "cfg_init",
        upstream: {
          base_url: "https://router.example/v1",
          api_key: "router-key",
          default_model: "model-init",
          image_model: "image-init",
        },
        models: [],
        updates: { channel: "stable", npm_package: "@hooliy/9codex", npm_registry: "https://registry.npmjs.org" },
        commands: { events_url: "/v1/agent/events", heartbeat_interval_seconds: 60 },
      }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-init-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig({ deviceName: "TEST-PC" });
  config.control_plane.base_url = baseUrl;
  config.upstream = {
    base_url: "https://fallback.example/v1",
    api_key: "fallback-key",
    default_model: "fallback-model",
    image_model: "fallback-image",
  };
  saveConfigAtomic(paths, config);
  let openedUrl;
  const callback = {
    redirectUri: "http://127.0.0.1:24567/callback",
    waitForCode: async () => ({ code: "code_init", state: "state_init" }),
    close: async () => {},
  };

  const result = await runInitFlow(paths, baseUrl, {
    version: "3.0.0",
    platform: "windows",
    state: "state_init",
    startCallbackServer: async () => callback,
    openBrowser: async (url) => { openedUrl = url; },
  });

  assert.equal(openedUrl, "https://login.example/authorize/req_init");
  assert.equal(authorizationBody.redirect_uri, callback.redirectUri);
  assert.equal(authorizationBody.code_challenge_method, "S256");
  assert.equal(result.control_plane.authorization_id, "auth_init");
  assert.equal(result.control_plane.refresh_token, "refresh_init");
  assert.equal(result.upstream.default_model, "model-init");
});
