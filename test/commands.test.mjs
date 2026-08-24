import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CommandError, executeCommand, validateCommand } from "../lib/commands.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function command(overrides = {}) {
  return {
    command_id: "cmd_1",
    sequence: 1,
    type: "service.restart",
    issued_at: "2026-08-01T08:00:00Z",
    expires_at: "2026-08-01T08:10:00Z",
    payload: {},
    ...overrides,
  };
}

const now = new Date("2026-08-01T08:05:00Z");

test("rejects unknown, expired, duplicate, and out-of-sequence commands", () => {
  const state = { last_sequence: 5, processed_ids: ["cmd_done"] };
  const cases = [
    [command({ command_id: "cmd_unknown", sequence: 6, type: "shell.run" }), "unknown_command"],
    [command({ command_id: "cmd_expired", sequence: 6, expires_at: "2026-08-01T08:04:00Z" }), "expired_command"],
    [command({ command_id: "cmd_done", sequence: 6 }), "duplicate_command"],
    [command({ command_id: "cmd_old", sequence: 5 }), "out_of_sequence"],
    [command({ command_id: "cmd_gap", sequence: 7 }), "out_of_sequence"],
  ];

  for (const [input, expectedCode] of cases) {
    assert.throws(
      () => validateCommand(input, state, now),
      (error) => error instanceof CommandError && error.code === expectedCode,
    );
  }
});

test("persists replay protection only after an accepted command succeeds", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-command-test-"));
  const paths = resolvePaths(home);
  let restarted = 0;

  const result = await executeCommand(command(), {
    paths,
    now: () => now,
    config: {},
    restartService: async () => { restarted += 1; },
  });

  assert.equal(result.service_restart_requested, true);
  assert.equal(restarted, 0);
  const state = JSON.parse(fs.readFileSync(paths.commandState, "utf8"));
  assert.equal(state.last_sequence, 1);
  assert.deepEqual(state.processed_ids, ["cmd_1"]);
  await assert.rejects(
    () => executeCommand(command(), {
      paths,
      now: () => now,
      config: {},
      restartService: async () => {},
    }),
    (error) => error.code === "duplicate_command",
  );
});

test("config refresh does not write or restart Codex", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-command-test-"));
  const paths = resolvePaths(home);
  const deferred = [];

  const result = await executeCommand(command({ type: "config.refresh" }), {
    paths,
    now: () => now,
    config: {},
    syncConfig: async () => ({ changed: true, config: { control_plane: {} } }),
    deferAfterAck: (operation) => deferred.push(operation),
    restartService: async () => {},
  });

  assert.deepEqual(result, {
    config_changed: true,
    config_revision: null,
    service_restart_requested: true,
  });
  assert.equal(deferred.length, 1);
});

test("failed commands remain replayable after the dependency recovers", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-command-test-"));
  const paths = resolvePaths(home);
  let healthy = false;
  const context = {
    paths,
    now: () => now,
    config: {},
    syncConfig: async () => {
      if (!healthy) throw new Error("refresh failed");
      return { changed: false, config: { control_plane: {} } };
    },
  };
  const refresh = command({ type: "config.refresh" });

  await assert.rejects(() => executeCommand(refresh, context), /refresh failed/);
  assert.equal(fs.existsSync(paths.commandState), false);
  healthy = true;
  assert.deepEqual(await executeCommand(refresh, context), {
    config_changed: false,
    config_revision: null,
    service_restart_requested: false,
  });
});

test("allows only typed package update payloads and does not accept shell text", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-command-test-"));
  const paths = resolvePaths(home);

  await assert.rejects(
    () => executeCommand(command({
      type: "package.update",
      payload: { package: "other-package", version: "3.0.1", command: "whoami" },
    }), {
      paths,
      now: () => now,
      config: {},
      updatePackage: async () => ({ updated: true }),
    }),
    (error) => error.code === "invalid_payload",
  );
});
