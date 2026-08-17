import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ControlPlaneError,
  createAuthorization,
  exchangeAuthorizationCode,
  syncBootstrap,
} from "../lib/control-plane.mjs";
import { reconcileModelState, validateModelState } from "../lib/model-state.mjs";
import { resolvePaths } from "../lib/paths.mjs";

async function fixtureServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function baseConfig(baseUrl) {
  return {
    schema_version: 1,
    installation: { installation_id: "ins_test" },
    control_plane: {
      base_url: baseUrl,
      authorization_id: "auth_test",
      access_token: "old-access",
      refresh_token: "refresh-token",
      config_revision: "cfg_old",
      poll_interval_seconds: 300,
      events_enabled: true,
    },
    local: { host: "127.0.0.1", port: 10101, token: "9codex_local_test" },
    upstream: {
      base_url: "https://old.example/v1",
      api_key: "old-key",
      default_model: "old-model",
      image_model: "old-image",
    },
    models: {
      namespace: "9codex",
      refresh_interval_seconds: 300,
      source_base_url: "https://old.example/v1",
      enabled_ids: null,
      available: [{ id: "old-model", context_window: 128_000 }],
    },
    updates: { enabled: true, channel: "stable", auto_install: true },
    codex: { inject_config: true, restart_policy: "automatic", restart_required: false },
  };
}

function modelStateBytes(paths) {
  return Object.fromEntries(
    ["config", "catalog", "modelMap"].map((key) => [key, fs.readFileSync(paths[key])]),
  );
}

test("sends the documented authorization and token exchange contracts", async (t) => {
  const requests = [];
  const fixture = await fixtureServer(async (req, res) => {
    const body = await new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    requests.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/cli/authorizations") {
      res.end(JSON.stringify({
        request_id: "req_test",
        authorization_url: `${fixture.baseUrl}/authorize?request_id=req_test`,
        expires_in: 600,
      }));
    } else {
      res.end(JSON.stringify({
        authorization_id: "auth_test",
        access_token: "access-token",
        access_token_expires_in: 3600,
        refresh_token: "refresh-token",
        refresh_token_expires_at: null,
      }));
    }
  });
  t.after(fixture.close);

  const authorization = await createAuthorization(fixture.baseUrl, {
    client: "9codex-cli",
    client_version: "3.0.0",
    installation_id: "ins_test",
    device_name: "TEST-PC",
    platform: "windows",
    redirect_uri: "http://127.0.0.1:23456/callback",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  });
  const tokens = await exchangeAuthorizationCode(fixture.baseUrl, {
    request_id: authorization.request_id,
    authorization_code: "code_test",
    code_verifier: "verifier",
    installation_id: "ins_test",
  });

  assert.equal(requests[0].url, "/v1/cli/authorizations");
  assert.equal(requests[0].body.code_challenge_method, "S256");
  assert.equal(requests[1].url, "/v1/cli/tokens");
  assert.equal(requests[1].body.code_verifier, "verifier");
  assert.equal(tokens.refresh_token_expires_at, null);
});

test("refreshes an access token, retries bootstrap, and atomically applies a valid revision", async (t) => {
  let bootstrapCalls = 0;
  const fixture = await fixtureServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/cli/tokens/refresh") {
      res.end(JSON.stringify({ access_token: "new-access", access_token_expires_in: 3600 }));
      return;
    }
    bootstrapCalls += 1;
    if (req.headers.authorization === "Bearer old-access") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { code: "access_token_expired" } }));
      return;
    }
    assert.equal(req.headers.authorization, "Bearer new-access");
    assert.equal(req.headers["if-none-match"], '"cfg_old"');
    res.setHeader("etag", '"cfg_new"');
    res.end(JSON.stringify({
      revision: "cfg_new",
      upstream: {
        base_url: "https://new.example/v1",
        api_key: "new-key",
        default_model: "new-model",
        image_model: "new-image",
      },
      models: [{
        id: "new-model",
        enabled: true,
        protocol: "responses_native",
        context_window: 1_050_000,
        capabilities: { streaming: true, tools: true },
      }],
      updates: {
        channel: "stable",
        latest_version: "3.0.1",
        minimum_version: "3.0.0",
        npm_package: "@hooliy/9codex",
        npm_registry: "https://registry.npmjs.org",
      },
      commands: { events_url: "/v1/agent/events", heartbeat_interval_seconds: 60 },
    }));
  });
  t.after(fixture.close);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-control-test-"));
  const paths = resolvePaths(home);
  const initial = baseConfig(fixture.baseUrl);
  await reconcileModelState(paths, initial, {
    authoritativeModels: initial.models.available,
  });

  const result = await syncBootstrap(paths, initial);

  assert.equal(result.changed, true);
  assert.equal(result.config.control_plane.access_token, "new-access");
  assert.equal(result.config.control_plane.config_revision, "cfg_new");
  assert.equal(result.config.upstream.base_url, "https://new.example/v1");
  assert.equal(result.config.upstream.api_key, "new-key");
  assert.equal(result.config.models.available[0].id, "new-model");
  assert.equal(result.config.models.source_base_url, "https://new.example/v1");
  assert.equal(result.config.models.enabled_ids, null);
  assert.equal(bootstrapCalls, 2);
  assert.equal(validateModelState(paths, result.config), true);
});

test("treats ETag 304 as unchanged", async (t) => {
  const fixture = await fixtureServer((req, res) => {
    assert.equal(req.headers["if-none-match"], '"cfg_old"');
    res.writeHead(304);
    res.end();
  });
  t.after(fixture.close);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-control-test-"));
  const paths = resolvePaths(home);
  const config = baseConfig(fixture.baseUrl);
  await reconcileModelState(paths, config, {
    authoritativeModels: config.models.available,
  });

  const result = await syncBootstrap(paths, config);

  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(paths.config, "utf8").includes("old-key"), true);
});

test("does not replace the active config when bootstrap is malformed", async (t) => {
  const fixture = await fixtureServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ revision: "cfg_bad", upstream: { base_url: "not-a-url" } }));
  });
  t.after(fixture.close);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-control-test-"));
  const paths = resolvePaths(home);
  const config = baseConfig(fixture.baseUrl);
  await reconcileModelState(paths, config, {
    authoritativeModels: config.models.available,
  });
  const before = fs.readFileSync(paths.config, "utf8");

  await assert.rejects(() => syncBootstrap(paths, config), /bootstrap\.upstream\.base_url/);
  assert.equal(fs.readFileSync(paths.config, "utf8"), before);
});

test("uses a conservative missing bootstrap context and rejects explicit invalid values atomically", async (t) => {
  let models = [];
  const fixture = await fixtureServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      revision: "cfg_bad_models",
      upstream: {
        base_url: "https://new.example/v1",
        api_key: "new-key",
        default_model: "new-model",
        image_model: "new-image",
      },
      models,
    }));
  });
  t.after(fixture.close);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-control-test-"));
  const paths = resolvePaths(home);
  const config = baseConfig(fixture.baseUrl);
  await reconcileModelState(paths, config, {
    authoritativeModels: config.models.available,
  });
  const before = modelStateBytes(paths);

  models = [];
  await assert.rejects(() => syncBootstrap(paths, config), /No usable model metadata/);
  assert.deepEqual(modelStateBytes(paths), before, "empty");

  models = [{ id: "new-model" }];
  const synced = await syncBootstrap(paths, config);
  assert.equal(synced.config.models.available[0].context_window, 128_000);
  assert.equal(synced.config.models.source_base_url, "https://new.example/v1");
  const valid = modelStateBytes(paths);

  models = [{ id: "new-model", context_window: 0 }];
  await assert.rejects(
    () => syncBootstrap(paths, synced.config),
    /context_window.*new-model|new-model.*context_window/,
  );
  assert.deepEqual(modelStateBytes(paths), valid, "invalid context");
});

test("surfaces explicit server revocation without deleting local configuration", async (t) => {
  const fixture = await fixtureServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "authorization_revoked" } }));
  });
  t.after(fixture.close);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-control-test-"));
  const paths = resolvePaths(home);
  const config = baseConfig(fixture.baseUrl);
  await reconcileModelState(paths, config, {
    authoritativeModels: config.models.available,
  });

  await assert.rejects(
    () => syncBootstrap(paths, config),
    (error) => error instanceof ControlPlaneError && error.code === "authorization_revoked",
  );
  assert.equal(fs.existsSync(paths.config), true);
});
