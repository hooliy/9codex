import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 4;

const JSON_COLUMNS = new Set([
  "acceptance_criteria",
  "changed_files",
  "evidence_ids",
  "metadata",
  "payload",
  "runtime_metadata",
  "source_metadata",
  "write_set",
]);
const STATE_TABLES = new Set(["task_groups", "work_items", "worker_sessions", "runs"]);
const RUNTIME_KINDS = new Set(["codex", "deepseek-harness"]);
const ACTIVE_TASK_GROUP_STATUSES = new Set(["planning", "executing", "integrating", "verifying"]);

export class TeamStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TeamStoreError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class TeamStoreMigrationError extends TeamStoreError {
  constructor(message, details = {}) {
    super("migration_failed", message, details);
    this.name = "TeamStoreMigrationError";
  }
}

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json(value, fallback = null) {
  return JSON.stringify(value ?? fallback);
}

function parseJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hydrate(row) {
  if (!row) return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      JSON_COLUMNS.has(key) ? parseJson(value) : value,
    ]),
  );
}

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TeamStoreError("invalid_input", `${name} is required`);
  }
  return value;
}

function requireVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TeamStoreError("invalid_input", "expectedVersion must be a non-negative integer");
  }
}

function requireRuntimeKind(value) {
  if (!RUNTIME_KINDS.has(value)) {
    throw new TeamStoreError(
      "invalid_runtime_kind",
      "runtimeKind must be codex or deepseek-harness",
    );
  }
  return value;
}

function removeSqliteSidecars(dbPath) {
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

function configure(db, busyTimeout) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeout) || 5000)};
    PRAGMA journal_mode = WAL;
  `);
}

const MIGRATION_1 = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    backup_path TEXT
  ) STRICT;

  CREATE TABLE task_groups (
    id TEXT PRIMARY KEY,
    origin_thread_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN (
      'collecting','awaiting_confirmation','planning','executing','integrating',
      'verifying','awaiting_user','done','blocked','paused','canceled'
    )),
    workspace TEXT NOT NULL,
    current_requirement_revision_id TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE TABLE conversation_bindings (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('origin','internal')),
    worker_session_id TEXT REFERENCES worker_sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE demand_events (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    source_message_id TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    classified_type TEXT CHECK (classified_type IS NULL OR classified_type IN (
      'new_requirement','requirement_change','clarification','bug_report',
      'acceptance_feedback','priority_change','pause','resume','cancel','approval'
    )),
    classification_confidence REAL CHECK (
      classification_confidence IS NULL OR
      (classification_confidence >= 0 AND classification_confidence <= 1)
    ),
    received_at TEXT NOT NULL,
    processed_at TEXT,
    result_json TEXT
  ) STRICT;

  CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','passed','canceled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE requirement_revisions (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    source_message_id TEXT NOT NULL,
    normalized_requirement TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL,
    impact_summary TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
    created_at TEXT NOT NULL,
    UNIQUE (requirement_id, revision)
  ) STRICT;

  CREATE UNIQUE INDEX one_active_revision_per_requirement
    ON requirement_revisions(requirement_id) WHERE status = 'active';

  CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    requirement_revision_id TEXT NOT NULL REFERENCES requirement_revisions(id),
    parent_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN (
      'backlog','ready','assigned','running','reported','verifying','failed',
      'rework','passed','closed','stale','blocked','canceled','revalidate'
    )),
    priority INTEGER NOT NULL DEFAULT 0,
    write_set TEXT NOT NULL DEFAULT '[]',
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE work_item_dependencies (
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (work_item_id, depends_on_id),
    CHECK (work_item_id <> depends_on_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE worker_sessions (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    codex_thread_id TEXT UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('planner','worker','reviewer','integrator')),
    status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN (
      'creating','idle','running','waiting','closing','closed',
      'lost','corrupted','interrupted'
    )),
    workspace TEXT NOT NULL,
    branch TEXT,
    worktree TEXT,
    context_checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
    last_heartbeat_at TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  ) STRICT;

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    worker_session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    requirement_revision_id TEXT REFERENCES requirement_revisions(id),
    role TEXT NOT NULL CHECK (role IN ('planner','worker','reviewer','integrator')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (
      status IN ('queued','running','reported','interrupted','failed','passed')
    ),
    report TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX one_running_run_per_worker_session
    ON runs(worker_session_id) WHERE status = 'running';

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    aggregate_version INTEGER,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX events_by_task_group ON events(task_group_id, id);

  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
    worker_session_id TEXT REFERENCES worker_sessions(id) ON DELETE SET NULL,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE work_item_leases (
    work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
    worker_session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE resource_locks (
    resource_key TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    worker_session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    UNIQUE (resource_key, token)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    command TEXT,
    exit_code INTEGER,
    output_path TEXT,
    artifact_path TEXT,
    content_hash TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE acceptances (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('work_item','requirement','task_group')),
    scope_id TEXT NOT NULL,
    criteria TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('passed','failed')),
    evidence_ids TEXT NOT NULL,
    failure_reason TEXT,
    verified_by_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    CHECK (result <> 'failed' OR failure_reason IS NOT NULL)
  ) STRICT;

  CREATE INDEX acceptances_by_scope ON acceptances(scope, scope_id, created_at);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT,
    size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT
  ) STRICT;

  CREATE INDEX outbox_pending ON outbox(published_at, id);

  CREATE TRIGGER conversation_internal_session_required
  BEFORE INSERT ON conversation_bindings
  WHEN NEW.kind = 'internal' AND NEW.worker_session_id IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'internal conversation requires worker_session_id');
  END;

  CREATE TRIGGER conversation_origin_session_forbidden
  BEFORE INSERT ON conversation_bindings
  WHEN NEW.kind = 'origin' AND NEW.worker_session_id IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'origin conversation cannot have worker_session_id');
  END;
`;

const MIGRATION_2 = `
  ALTER TABLE task_groups ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex'
    CHECK (runtime_kind IN ('codex','deepseek-harness'));

  ALTER TABLE runs ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'codex'
    CHECK (runtime_kind IN ('codex','deepseek-harness'));

  CREATE TABLE worker_sessions_v2 (
    id TEXT PRIMARY KEY,
    task_group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('codex','deepseek-harness')),
    runtime_session_id TEXT,
    runtime_metadata TEXT NOT NULL DEFAULT '{}',
    role TEXT NOT NULL CHECK (role IN ('planner','worker','reviewer','integrator')),
    status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN (
      'creating','idle','running','waiting','closing','closed',
      'lost','corrupted','interrupted'
    )),
    workspace TEXT NOT NULL,
    branch TEXT,
    worktree TEXT,
    context_checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
    last_heartbeat_at TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE(runtime_kind, runtime_session_id)
  ) STRICT;

  INSERT INTO worker_sessions_v2(
    id, task_group_id, work_item_id, runtime_kind, runtime_session_id,
    runtime_metadata, role, status, workspace, branch, worktree,
    context_checkpoint_id, last_heartbeat_at, version, created_at, updated_at, closed_at
  )
  SELECT
    id, task_group_id, work_item_id, 'codex', codex_thread_id,
    '{}', role, status, workspace, branch, worktree,
    context_checkpoint_id, last_heartbeat_at, version, created_at, updated_at, closed_at
  FROM worker_sessions;

  DROP TABLE worker_sessions;
  ALTER TABLE worker_sessions_v2 RENAME TO worker_sessions;

`;

const MIGRATION_3 = `
  ALTER TABLE demand_events ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'message';
  ALTER TABLE demand_events ADD COLUMN source_reference TEXT NOT NULL DEFAULT 'legacy-message';
  ALTER TABLE demand_events ADD COLUMN source_fingerprint TEXT;
  ALTER TABLE demand_events ADD COLUMN source_metadata TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE demand_events ADD COLUMN confirmed_at TEXT;

  ALTER TABLE requirement_revisions ADD COLUMN source_event_id TEXT REFERENCES demand_events(id);
  ALTER TABLE requirement_revisions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'message';
  ALTER TABLE requirement_revisions ADD COLUMN source_reference TEXT NOT NULL DEFAULT 'legacy-message';
  ALTER TABLE requirement_revisions ADD COLUMN source_fingerprint TEXT;
  ALTER TABLE requirement_revisions ADD COLUMN confirmed_at TEXT;

  CREATE INDEX demand_events_by_source_fingerprint
    ON demand_events(task_group_id, source_fingerprint, received_at);
`;

function rewriteImpactActions(value) {
  if (!value || typeof value !== "object") return value;
  for (const requirement of value.proposal?.requirements || []) {
    const actions = requirement?.impactActions;
    if (!actions || Array.isArray(actions) || typeof actions !== "object") continue;
    requirement.impactActions = Object.entries(actions).map(([workItemId, action]) => ({
      workItemId,
      action,
    }));
  }
  if (Array.isArray(value.proposedRequirements)) {
    value.proposedRequirements = value.proposal?.requirements || value.proposedRequirements;
  }
  return value;
}

function migrateDemandProposalImpactActions(db) {
  const update = db.prepare("UPDATE demand_events SET result_json = ? WHERE id = ?");
  for (const row of db.prepare(
    "SELECT id, result_json FROM demand_events WHERE result_json IS NOT NULL",
  ).all()) {
    let parsed;
    try {
      parsed = JSON.parse(row.result_json);
    } catch {
      continue;
    }
    const rewritten = JSON.stringify(rewriteImpactActions(parsed));
    if (rewritten !== row.result_json) update.run(rewritten, row.id);
  }
}

const DEFAULT_MIGRATIONS = [
  { version: 1, up: (db) => db.exec(MIGRATION_1) },
  { version: 2, up: (db) => db.exec(MIGRATION_2) },
  { version: 3, up: (db) => db.exec(MIGRATION_3) },
  { version: 4, up: migrateDemandProposalImpactActions },
];

function normalizeMigrations(options) {
  const migrations = options.migrations || DEFAULT_MIGRATIONS;
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const targetVersion = options.targetVersion ?? ordered.at(-1)?.version ?? 0;
  for (let version = 1; version <= targetVersion; version += 1) {
    if (!ordered.some((migration) => migration.version === version)) {
      throw new TeamStoreError("invalid_migrations", `missing migration ${version}`);
    }
  }
  return { migrations: ordered, targetVersion };
}

async function backupDatabase(db, backupPath) {
  await backup(db, backupPath);
}

async function migrate(dbPath, options) {
  const busyTimeout = options.busyTimeout ?? 5000;
  const existed = fs.existsSync(dbPath);
  let db = new DatabaseSync(dbPath);
  configure(db, busyTimeout);
  const currentVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
  const { migrations, targetVersion } = normalizeMigrations(options);
  if (currentVersion > targetVersion) {
    db.close();
    throw new TeamStoreError(
      "schema_too_new",
      `database schema ${currentVersion} is newer than supported ${targetVersion}`,
    );
  }
  if (currentVersion === targetVersion) return { db, backupPath: null };

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  const backupPath = existed
    ? `${dbPath}.backup-v${currentVersion}-${Date.now()}`
    : null;
  if (backupPath) await backupDatabase(db, backupPath);
  db.close();

  try {
    db = new DatabaseSync(dbPath);
    configure(db, busyTimeout);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN EXCLUSIVE");
    for (const migration of migrations) {
      if (migration.version <= currentVersion || migration.version > targetVersion) continue;
      migration.up(db);
      options.migrationHook?.({ db, version: migration.version, backupPath });
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at, backup_path) VALUES (?, ?, ?)",
      ).run(migration.version, nowIso(options.now), backupPath);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length) {
      throw new Error(`foreign key check failed: ${JSON.stringify(foreignKeyErrors)}`);
    }
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
    return { db, backupPath };
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    try {
      db.close();
    } catch {}
    removeSqliteSidecars(dbPath);
    if (backupPath) fs.copyFileSync(backupPath, dbPath);
    else fs.rmSync(dbPath, { force: true });
    removeSqliteSidecars(dbPath);
    throw new TeamStoreMigrationError(`database migration failed: ${cause.message}`, {
      cause,
      backupPath,
      fromVersion: currentVersion,
      targetVersion,
    });
  }
}

export async function openTeamStore(dbPath, options = {}) {
  requireText(dbPath, "dbPath");
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  fs.chmodSync(path.dirname(path.resolve(dbPath)), 0o700);
  const { db, backupPath } = await migrate(path.resolve(dbPath), options);
  fs.chmodSync(path.resolve(dbPath), 0o600);
  return new TeamStore(db, path.resolve(dbPath), { ...options, backupPath });
}

export function verifyTeamStoreBackup(backupPath) {
  requireText(backupPath, "backupPath");
  const db = new DatabaseSync(path.resolve(backupPath), { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (integrity !== "ok" || foreignKeyErrors.length > 0) {
      throw new TeamStoreError("invalid_backup", "backup integrity verification failed", {
        integrity,
        foreignKeyErrors,
      });
    }
    return {
      path: path.resolve(backupPath),
      schemaVersion,
      events: Number(db.prepare("SELECT COUNT(*) AS count FROM events").get().count),
      outbox: Number(db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count),
    };
  } finally {
    db.close();
  }
}

export class TeamStore {
  constructor(db, dbPath, options = {}) {
    this.db = db;
    this.path = dbPath;
    this.lastMigrationBackupPath = options.backupPath || null;
    this.now = options.now || (() => new Date());
    this.transactionDepth = 0;
  }

  close() {
    this.db.close();
  }

  async createBackup(destination) {
    requireText(destination, "destination");
    const backupPath = path.resolve(destination);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    if (fs.existsSync(backupPath)) {
      throw new TeamStoreError("backup_exists", `backup already exists: ${backupPath}`);
    }
    await backupDatabase(this.db, backupPath);
    fs.chmodSync(backupPath, 0o600);
    return verifyTeamStoreBackup(backupPath);
  }

  transaction(callback) {
    if (typeof callback !== "function") {
      throw new TeamStoreError("invalid_input", "transaction callback is required");
    }
    const savepoint = `team_store_${this.transactionDepth}`;
    this.db.exec(this.transactionDepth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = callback(this);
      if (result && typeof result.then === "function") {
        throw new TeamStoreError("async_transaction", "transactions must be synchronous");
      }
      this.transactionDepth -= 1;
      this.db.exec(this.transactionDepth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      this.db.exec(this.transactionDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`);
      if (this.transactionDepth > 0) this.db.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  pragma(name) {
    if (!["journal_mode", "foreign_keys", "busy_timeout", "user_version"].includes(name)) {
      throw new TeamStoreError("invalid_input", "unsupported pragma");
    }
    return this.db.prepare(`PRAGMA ${name}`).get();
  }

  get(table, recordId) {
    if (![
      "task_groups","demand_events","requirements","requirement_revisions","work_items",
      "worker_sessions","runs","checkpoints","evidence","acceptances","artifacts",
    ].includes(table)) throw new TeamStoreError("invalid_input", "unsupported table");
    return hydrate(this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(recordId));
  }

  listEvents(taskGroupId, afterId = 0) {
    return this.db.prepare(
      "SELECT * FROM events WHERE task_group_id = ? AND id > ? ORDER BY id",
    ).all(taskGroupId, afterId).map(hydrate);
  }

  recordExternalEvent(input) {
    requireText(input?.taskGroupId, "taskGroupId");
    requireText(input?.aggregateType, "aggregateType");
    requireText(input?.aggregateId, "aggregateId");
    requireText(input?.eventType, "eventType");
    return this.transaction(() => this.#emit(
      input.taskGroupId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      null,
      input.payload || {},
    ));
  }

  updateTaskGroupWorkspace(id, input) {
    requireText(input?.workspace, "workspace");
    requireVersion(input?.expectedVersion);
    return this.transaction(() => {
      const current = this.get("task_groups", id);
      if (!current) throw new TeamStoreError("not_found", "task group not found");
      const timestamp = nowIso(this.now);
      const result = this.db.prepare(`
        UPDATE task_groups SET workspace = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(input.workspace, timestamp, id, input.expectedVersion);
      if (result.changes !== 1) throw new TeamStoreError("version_conflict", "task group changed");
      const updated = this.get("task_groups", id);
      this.#emit(id, "task_group", id, "task_group.workspace_changed", updated.version, {
        from: current.workspace,
        to: input.workspace,
        actor: input.actor || "orchestrator",
        source: input.source || "task_orchestrator",
      });
      return updated;
    });
  }

  changeTaskGroupRuntime(taskGroupId, input = {}) {
    const runtimeKind = requireRuntimeKind(input.runtimeKind);
    return this.transaction(() => {
      const current = this.get("task_groups", taskGroupId);
      if (!current) throw new TeamStoreError("not_found", "task group not found");
      if (current.runtime_kind === runtimeKind) return current;
      const activeRuns = Number(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM runs r
        JOIN worker_sessions ws ON ws.id = r.worker_session_id
        WHERE ws.task_group_id = ? AND r.status = 'running'
      `).get(taskGroupId).count);
      const activeWorkers = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM worker_sessions
        WHERE task_group_id = ? AND status IN ('creating','running')
      `).get(taskGroupId).count);
      if (ACTIVE_TASK_GROUP_STATUSES.has(current.status) || activeRuns || activeWorkers) {
        throw new TeamStoreError(
          "runtime_switch_blocked",
          "task group runtime cannot change while execution is active",
          { activeRuns, activeWorkers, taskGroupStatus: current.status },
        );
      }
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        UPDATE task_groups
        SET runtime_kind = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(runtimeKind, timestamp, taskGroupId);
      const updated = this.get("task_groups", taskGroupId);
      this.#emit(taskGroupId, "task_group", taskGroupId, "task_group.runtime_changed", updated.version, {
        from: current.runtime_kind,
        to: runtimeKind,
        actor: input.actor || "user",
        source: input.source || "team_store",
        reason: input.reason || null,
      });
      return updated;
    });
  }

  resolveActiveConversation(threadId = null) {
    const rows = this.db.prepare(`
      SELECT e.task_group_id, e.aggregate_id request_id, e.payload, e.created_at
      FROM events e
      JOIN task_groups task_group ON task_group.id = e.task_group_id
      WHERE e.event_type = 'gateway.request_started'
        AND (? IS NULL OR task_group.origin_thread_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM events completed
          WHERE completed.event_type = 'gateway.request_completed'
            AND completed.aggregate_id = e.aggregate_id
        )
      ORDER BY e.id DESC
    `).all(threadId, threadId).map(hydrate);
    const groups = new Set(rows.map((row) => row.task_group_id));
    if (groups.size !== 1 || rows.length === 0) return null;
    const latest = rows[0];
    const group = this.get("task_groups", latest.task_group_id);
    return group ? {
      taskGroupId: group.id,
      threadId: group.origin_thread_id,
      requestId: latest.request_id,
      startedAt: latest.created_at,
    } : null;
  }

  #emit(taskGroupId, aggregateType, aggregateId, eventType, aggregateVersion, payload = {}) {
    const createdAt = nowIso(this.now);
    const auditedPayload = {
      actor: payload.actor || "orchestrator",
      source: payload.source || "team_store",
      ...payload,
    };
    const result = this.db.prepare(`
      INSERT INTO events(
        task_group_id, aggregate_type, aggregate_id, event_type,
        aggregate_version, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskGroupId,
      aggregateType,
      aggregateId,
      eventType,
      aggregateVersion,
      json(auditedPayload, {}),
      createdAt,
    );
    const eventId = Number(result.lastInsertRowid);
    this.db.prepare(`
      INSERT INTO outbox(event_id, topic, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(eventId, eventType, json({
      eventId,
      taskGroupId,
      aggregateType,
      aggregateId,
      aggregateVersion,
      ...auditedPayload,
    }, {}), createdAt);
    return eventId;
  }

  createTaskGroup(input) {
    requireText(input?.originThreadId, "originThreadId");
    requireText(input?.title, "title");
    requireText(input?.workspace, "workspace");
    const existing = this.getTaskGroupByThread(input.originThreadId);
    if (existing) return existing;
    const runtimeKind = requireRuntimeKind(input.runtimeKind || "codex");
    return this.transaction(() => {
      const recordId = input.id || id("tg");
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        INSERT INTO task_groups(
          id, origin_thread_id, title, status, workspace, runtime_kind, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        input.originThreadId,
        input.title,
        input.status || "collecting",
        input.workspace,
        runtimeKind,
        timestamp,
        timestamp,
      );
      this.db.prepare(`
        INSERT INTO conversation_bindings(id, task_group_id, thread_id, kind, created_at)
        VALUES (?, ?, ?, 'origin', ?)
      `).run(id("cb"), recordId, input.originThreadId, timestamp);
      this.#emit(recordId, "task_group", recordId, "task_group.created", 0, {
        status: input.status || "collecting",
        runtimeKind,
      });
      return this.get("task_groups", recordId);
    });
  }

  getTaskGroupByThread(threadId) {
    return hydrate(this.db.prepare(`
      SELECT tg.* FROM task_groups tg
      JOIN conversation_bindings cb ON cb.task_group_id = tg.id
      WHERE cb.thread_id = ?
    `).get(threadId));
  }

  listTaskGroups() {
    return this.db.prepare(`
      SELECT
        tg.*,
        COALESCE((
          SELECT CAST(ROUND(100.0 * SUM(CASE WHEN wi.status IN ('passed','closed','canceled','stale') THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0)) AS INTEGER)
          FROM work_items wi WHERE wi.task_group_id = tg.id
        ), 0) AS progress,
        (SELECT COUNT(*) FROM worker_sessions ws
          WHERE ws.task_group_id = tg.id
            AND ws.role = 'worker'
            AND ws.status IN ('creating','running')
            AND EXISTS (
              SELECT 1 FROM runs r
              WHERE r.worker_session_id = ws.id AND r.status = 'running'
            )) AS running_workers,
        (SELECT COUNT(*) FROM work_items wi
          WHERE wi.task_group_id = tg.id AND wi.status = 'blocked') AS blocker_count,
        (SELECT COUNT(*) FROM demand_events de
          WHERE de.task_group_id = tg.id) AS demand_count,
        tg.status AS current_stage
      FROM task_groups tg
      ORDER BY tg.updated_at DESC, tg.id DESC
    `).all().map(hydrate);
  }

  deleteWorkItem(taskGroupId, workItemId) {
    requireText(taskGroupId, "taskGroupId");
    requireText(workItemId, "workItemId");
    return this.transaction(() => {
      const item = this.get("work_items", workItemId);
      if (!item) return false;
      if (item.task_group_id !== taskGroupId) {
        throw new TeamStoreError("invalid_scope", "work item belongs to another task group");
      }

      const ids = (sql, ...params) => this.db.prepare(sql).all(...params).map((row) => row.id);
      const sessionIds = ids("SELECT id FROM worker_sessions WHERE work_item_id = ?", workItemId);
      const runIds = ids(`
        SELECT DISTINCT r.id FROM runs r
        LEFT JOIN worker_sessions ws ON ws.id = r.worker_session_id
        WHERE r.work_item_id = ? OR ws.work_item_id = ?
      `, workItemId, workItemId);
      const checkpointIds = ids(`
        SELECT id FROM checkpoints
        WHERE work_item_id = ?
           OR worker_session_id IN (SELECT id FROM worker_sessions WHERE work_item_id = ?)
           OR run_id IN (
             SELECT r.id FROM runs r
             LEFT JOIN worker_sessions ws ON ws.id = r.worker_session_id
             WHERE r.work_item_id = ? OR ws.work_item_id = ?
           )
      `, workItemId, workItemId, workItemId, workItemId);
      const evidenceIds = ids(`
        SELECT id FROM evidence
        WHERE work_item_id = ?
           OR run_id IN (
             SELECT r.id FROM runs r
             LEFT JOIN worker_sessions ws ON ws.id = r.worker_session_id
             WHERE r.work_item_id = ? OR ws.work_item_id = ?
           )
      `, workItemId, workItemId, workItemId);
      const acceptanceIds = ids(`
        SELECT DISTINCT a.id FROM acceptances a
        WHERE a.task_group_id = ? AND (
          (a.scope = 'work_item' AND a.scope_id = ?)
          OR a.verified_by_run_id IN (
            SELECT r.id FROM runs r
            LEFT JOIN worker_sessions ws ON ws.id = r.worker_session_id
            WHERE r.work_item_id = ? OR ws.work_item_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM json_each(a.evidence_ids) linked
            JOIN evidence e ON e.id = linked.value
            WHERE e.work_item_id = ?
               OR e.run_id IN (
                 SELECT r.id FROM runs r
                 LEFT JOIN worker_sessions ws ON ws.id = r.worker_session_id
                 WHERE r.work_item_id = ? OR ws.work_item_id = ?
               )
          )
        )
      `, taskGroupId, workItemId, workItemId, workItemId, workItemId, workItemId, workItemId);
      const artifactIds = ids(`
        SELECT id FROM artifacts
        WHERE work_item_id = ?
           OR evidence_id IN (
             SELECT id FROM evidence
             WHERE work_item_id = ?
                OR run_id IN (
                  SELECT r.id FROM runs r
                  LEFT JOIN worker_sessions ws ON ws.id = r.worker_session_id
                  WHERE r.work_item_id = ? OR ws.work_item_id = ?
                )
           )
      `, workItemId, workItemId, workItemId, workItemId);

      for (const aggregateId of new Set([
        workItemId,
        ...sessionIds,
        ...runIds,
        ...checkpointIds,
        ...evidenceIds,
        ...acceptanceIds,
        ...artifactIds,
      ])) {
        this.db.prepare("DELETE FROM events WHERE task_group_id = ? AND aggregate_id = ?")
          .run(taskGroupId, aggregateId);
      }
      const deleteIds = (table, recordIds) => {
        const statement = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
        for (const recordId of recordIds) statement.run(recordId);
      };
      deleteIds("acceptances", acceptanceIds);
      deleteIds("artifacts", artifactIds);
      deleteIds("evidence", evidenceIds);
      deleteIds("checkpoints", checkpointIds);
      this.db.prepare("DELETE FROM work_item_leases WHERE work_item_id = ?").run(workItemId);
      this.db.prepare("DELETE FROM resource_locks WHERE work_item_id = ?").run(workItemId);
      for (const sessionId of sessionIds) {
        this.db.prepare("DELETE FROM conversation_bindings WHERE worker_session_id = ?").run(sessionId);
      }
      deleteIds("runs", runIds);
      deleteIds("worker_sessions", sessionIds);
      this.db.prepare("UPDATE work_items SET parent_id = NULL WHERE parent_id = ?").run(workItemId);
      this.db.prepare(`
        DELETE FROM work_item_dependencies
        WHERE work_item_id = ? OR depends_on_id = ?
      `).run(workItemId, workItemId);
      this.db.prepare("DELETE FROM work_items WHERE id = ?").run(workItemId);
      return true;
    });
  }

  deleteTaskGroup(taskGroupId) {
    requireText(taskGroupId, "taskGroupId");
    return this.transaction(() => (
      this.db.prepare("DELETE FROM task_groups WHERE id = ?").run(taskGroupId).changes === 1
    ));
  }

  clearTaskGroups() {
    return this.transaction(() => {
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM task_groups").get().count);
      this.db.prepare("DELETE FROM task_groups").run();
      return count;
    });
  }

  getTaskGroupSnapshot(taskGroupId, options = {}) {
    const taskGroup = this.get("task_groups", taskGroupId);
    if (!taskGroup) return null;
    const query = (sql) => this.db.prepare(sql).all(taskGroupId).map(hydrate);
    const snapshot = {
      ...taskGroup,
      requirements: query("SELECT * FROM requirements WHERE task_group_id = ? ORDER BY created_at, id"),
      requirement_revisions: query(`
        SELECT rr.* FROM requirement_revisions rr
        JOIN requirements r ON r.id = rr.requirement_id
        WHERE r.task_group_id = ? ORDER BY rr.created_at, rr.id
      `),
      demand_events: query("SELECT * FROM demand_events WHERE task_group_id = ? ORDER BY received_at, id"),
      work_items: query("SELECT * FROM work_items WHERE task_group_id = ? ORDER BY priority DESC, created_at, id"),
      work_item_dependencies: query(`
        SELECT d.* FROM work_item_dependencies d
        JOIN work_items wi ON wi.id = d.work_item_id
        WHERE wi.task_group_id = ? ORDER BY d.work_item_id, d.depends_on_id
      `),
      evidence: query("SELECT * FROM evidence WHERE task_group_id = ? ORDER BY created_at, id"),
      acceptances: query("SELECT * FROM acceptances WHERE task_group_id = ? ORDER BY created_at, id"),
      events: this.listEvents(taskGroupId),
    };
    if (options.includeWorkers) {
      snapshot.worker_sessions = query(
        "SELECT * FROM worker_sessions WHERE task_group_id = ? ORDER BY created_at, id",
      );
      snapshot.runs = query(`
        SELECT r.* FROM runs r
        JOIN worker_sessions ws ON ws.id = r.worker_session_id
        WHERE ws.task_group_id = ? ORDER BY r.created_at, r.id
      `);
      snapshot.checkpoints = query(
        "SELECT * FROM checkpoints WHERE task_group_id = ? ORDER BY created_at, id",
      );
    }
    return snapshot;
  }

  bindWorkerConversation({ taskGroupId, workerSessionId, threadId, id: bindingId }) {
    return this.transaction(() => {
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        INSERT INTO conversation_bindings(
          id, task_group_id, thread_id, kind, worker_session_id, created_at
        ) VALUES (?, ?, ?, 'internal', ?, ?)
      `).run(bindingId || id("cb"), taskGroupId, threadId, workerSessionId, timestamp);
      return { taskGroupId, workerSessionId, threadId };
    });
  }

  attachRuntimeSession(workerSessionId, runtimeSessionId, input = {}) {
    requireText(runtimeSessionId, "runtimeSessionId");
    return this.transaction(() => {
      const session = this.get("worker_sessions", workerSessionId);
      if (!session) throw new TeamStoreError("not_found", "worker session not found");
      this.db.prepare(
        `UPDATE worker_sessions
         SET runtime_session_id = ?, runtime_metadata = ?, updated_at = ?, version = version + 1
         WHERE id = ?`,
      ).run(
        runtimeSessionId,
        json(input.metadata, session.runtime_metadata || {}),
        nowIso(this.now),
        workerSessionId,
      );
      if (session.runtime_kind === "codex") {
        this.bindWorkerConversation({
          taskGroupId: session.task_group_id,
          workerSessionId,
          threadId: runtimeSessionId,
        });
      }
      const updated = this.get("worker_sessions", workerSessionId);
      this.#emit(session.task_group_id, "worker_session", workerSessionId, "worker_session.runtime_attached", updated.version, {
        runtimeKind: session.runtime_kind,
        runtimeSessionId,
        actor: input.actor || "orchestrator",
        source: input.source || session.runtime_kind,
      });
      return updated;
    });
  }

  appendDemandEvent(input) {
    requireText(input?.eventKey, "eventKey");
    requireText(input?.taskGroupId, "taskGroupId");
    requireText(input?.sourceMessageId, "sourceMessageId");
    requireText(input?.rawContent, "rawContent");
    const existing = hydrate(this.db.prepare(
      "SELECT * FROM demand_events WHERE event_key = ?",
    ).get(input.eventKey));
    if (existing) return { event: existing, created: false };
    return this.transaction(() => {
      const concurrent = hydrate(this.db.prepare(
        "SELECT * FROM demand_events WHERE event_key = ?",
      ).get(input.eventKey));
      if (concurrent) return { event: concurrent, created: false };
      const recordId = input.id || id("de");
      const receivedAt = input.receivedAt || nowIso(this.now);
      this.db.prepare(`
        INSERT INTO demand_events(
          id, event_key, task_group_id, source_message_id, raw_content,
          classified_type, classification_confidence, received_at, processed_at, result_json,
          source_kind, source_reference, source_fingerprint, source_metadata, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        input.eventKey,
        input.taskGroupId,
        input.sourceMessageId,
        input.rawContent,
        input.classifiedType ?? null,
        input.classificationConfidence ?? null,
        receivedAt,
        input.processedAt ?? null,
        input.result == null ? null : json(input.result),
        input.source?.kind || "message",
        input.source?.reference || input.sourceMessageId,
        input.source?.fingerprint ?? null,
        json(input.source?.metadata, {}),
        input.confirmedAt ?? null,
      );
      this.#emit(input.taskGroupId, "demand_event", recordId, "demand_event.received", null, {
        eventKey: input.eventKey,
        sourceMessageId: input.sourceMessageId,
        sourceKind: input.source?.kind || "message",
        sourceReference: input.source?.reference || input.sourceMessageId,
        sourceFingerprint: input.source?.fingerprint ?? null,
      });
      return { event: this.get("demand_events", recordId), created: true };
    });
  }

  confirmDemandEvent(eventKey, input = {}) {
    requireText(eventKey, "eventKey");
    return this.transaction(() => {
      const event = hydrate(this.db.prepare(
        "SELECT * FROM demand_events WHERE event_key = ?",
      ).get(eventKey));
      if (!event) throw new TeamStoreError("not_found", "demand event not found");
      if (event.confirmed_at) return event;
      const confirmedAt = input.confirmedAt || nowIso(this.now);
      this.db.prepare(
        "UPDATE demand_events SET confirmed_at = ? WHERE event_key = ?",
      ).run(confirmedAt, eventKey);
      this.#emit(event.task_group_id, "demand_event", event.id, "demand_event.confirmed", null, {
        confirmedAt,
        actor: input.actor || "user",
        source: input.source || event.source_message_id,
      });
      return this.get("demand_events", event.id);
    });
  }

  createRequirement(input) {
    return this.transaction(() => {
      const recordId = input.id || id("req");
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        INSERT INTO requirements(id, task_group_id, title, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        requireText(input.taskGroupId, "taskGroupId"),
        requireText(input.title, "title"),
        input.status || "active",
        timestamp,
        timestamp,
      );
      this.#emit(input.taskGroupId, "requirement", recordId, "requirement.created", null, {
        title: input.title,
      });
      return this.get("requirements", recordId);
    });
  }

  addRequirementRevision(input) {
    requireText(input?.requirementId, "requirementId");
    requireText(input?.sourceMessageId, "sourceMessageId");
    requireText(input?.normalizedRequirement, "normalizedRequirement");
    return this.transaction(() => {
      const requirement = this.get("requirements", input.requirementId);
      if (!requirement) throw new TeamStoreError("not_found", "requirement not found");
      const latest = this.db.prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM requirement_revisions WHERE requirement_id = ?
      `).get(input.requirementId);
      const revision = input.revision ?? Number(latest.revision) + 1;
      this.db.prepare(`
        UPDATE requirement_revisions SET status = 'superseded'
        WHERE requirement_id = ? AND status = 'active'
      `).run(input.requirementId);
      const recordId = input.id || id("rr");
      this.db.prepare(`
        INSERT INTO requirement_revisions(
          id, requirement_id, revision, source_message_id, normalized_requirement,
          acceptance_criteria, impact_summary, status, created_at,
          source_event_id, source_kind, source_reference, source_fingerprint, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        input.requirementId,
        revision,
        input.sourceMessageId,
        input.normalizedRequirement,
        json(input.acceptanceCriteria, []),
        input.impactSummary ?? null,
        nowIso(this.now),
        input.sourceEventId ?? null,
        input.source?.kind || "message",
        input.source?.reference || input.sourceMessageId,
        input.source?.fingerprint ?? null,
        input.confirmedAt ?? nowIso(this.now),
      );
      this.db.prepare(`
        UPDATE task_groups
        SET current_requirement_revision_id = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(recordId, nowIso(this.now), requirement.task_group_id);
      const group = this.get("task_groups", requirement.task_group_id);
      this.#emit(
        requirement.task_group_id,
        "requirement_revision",
        recordId,
        "requirement_revision.created",
        revision,
        { requirementId: input.requirementId, revision },
      );
      this.#emit(
        requirement.task_group_id,
        "task_group",
        requirement.task_group_id,
        "task_group.requirement_revision_changed",
        group.version,
        { requirementRevisionId: recordId },
      );
      return this.get("requirement_revisions", recordId);
    });
  }

  createWorkItem(input) {
    return this.transaction(() => {
      const recordId = input.id || id("wi");
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        INSERT INTO work_items(
          id, task_group_id, requirement_revision_id, parent_id, title, description,
          status, priority, write_set, acceptance_criteria, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        requireText(input.taskGroupId, "taskGroupId"),
        requireText(input.requirementRevisionId, "requirementRevisionId"),
        input.parentId ?? null,
        requireText(input.title, "title"),
        input.description || "",
        input.status || "backlog",
        input.priority ?? 0,
        json(input.writeSet, []),
        json(input.acceptanceCriteria, []),
        timestamp,
        timestamp,
      );
      for (const dependencyId of input.dependencies || []) {
        this.addWorkItemDependency(recordId, dependencyId);
      }
      this.#emit(input.taskGroupId, "work_item", recordId, "work_item.created", 0, {
        status: input.status || "backlog",
      });
      return this.get("work_items", recordId);
    });
  }

  addWorkItemDependency(workItemId, dependsOnId) {
    const item = this.get("work_items", workItemId);
    const dependency = this.get("work_items", dependsOnId);
    if (!item || !dependency) throw new TeamStoreError("not_found", "work item not found");
    if (item.task_group_id !== dependency.task_group_id) {
      throw new TeamStoreError("cross_task_group_dependency", "dependency must share task group");
    }
    this.db.prepare(`
      INSERT INTO work_item_dependencies(work_item_id, depends_on_id, created_at)
      VALUES (?, ?, ?)
    `).run(workItemId, dependsOnId, nowIso(this.now));
  }

  listReadyWorkItems(taskGroupId) {
    return this.db.prepare(`
      SELECT wi.* FROM work_items wi
      JOIN requirement_revisions rr ON rr.id = wi.requirement_revision_id
      WHERE wi.task_group_id = ? AND wi.status = 'ready'
        AND rr.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM work_item_dependencies d
          JOIN work_items dependency ON dependency.id = d.depends_on_id
          WHERE d.work_item_id = wi.id AND dependency.status <> 'closed'
        )
      ORDER BY wi.priority DESC, wi.created_at, wi.id
    `).all(taskGroupId).map(hydrate);
  }

  createWorkerSession(input) {
    return this.transaction(() => {
      const taskGroupId = requireText(input.taskGroupId, "taskGroupId");
      const taskGroup = this.get("task_groups", taskGroupId);
      if (!taskGroup) throw new TeamStoreError("not_found", "task group not found");
      const runtimeKind = requireRuntimeKind(input.runtimeKind || taskGroup.runtime_kind);
      if (runtimeKind !== taskGroup.runtime_kind) {
        throw new TeamStoreError(
          "runtime_mismatch",
          "worker runtime must match task group runtime",
        );
      }
      const recordId = input.id || id("ws");
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        INSERT INTO worker_sessions(
          id, task_group_id, work_item_id, runtime_kind, runtime_session_id,
          runtime_metadata, role, status,
          workspace, branch, worktree, last_heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        taskGroupId,
        input.workItemId ?? null,
        runtimeKind,
        input.runtimeSessionId ?? null,
        json(input.runtimeMetadata, {}),
        input.role || "worker",
        input.status || "creating",
        requireText(input.workspace, "workspace"),
        input.branch ?? null,
        input.worktree ?? null,
        input.lastHeartbeatAt ?? null,
        timestamp,
        timestamp,
      );
      if (runtimeKind === "codex" && input.runtimeSessionId) {
        this.bindWorkerConversation({
          taskGroupId,
          workerSessionId: recordId,
          threadId: input.runtimeSessionId,
        });
      }
      this.#emit(taskGroupId, "worker_session", recordId, "worker_session.created", 0, {
        role: input.role || "worker",
        status: input.status || "creating",
        runtimeKind,
      });
      return this.get("worker_sessions", recordId);
    });
  }

  prepareWorkerSession(workerSessionId, input = {}) {
    const session = this.get("worker_sessions", workerSessionId);
    if (!session) throw new TeamStoreError("not_found", "worker session not found");
    const timestamp = nowIso(this.now);
    this.db.prepare(`
      UPDATE worker_sessions
      SET status = ?, workspace = ?, branch = ?, worktree = ?, updated_at = ?, version = version + 1
      WHERE id = ?
    `).run(
      input.status || "creating",
      input.workspace || session.workspace,
      input.branch ?? session.branch,
      input.worktree ?? session.worktree,
      timestamp,
      workerSessionId,
    );
    return this.get("worker_sessions", workerSessionId);
  }

  heartbeatWorkerSession(workerSessionId, input = {}) {
    const session = this.get("worker_sessions", workerSessionId);
    if (!session) throw new TeamStoreError("not_found", "worker session not found");
    const timestamp = input.timestamp || nowIso(this.now);
    const result = this.db.prepare(`
      UPDATE worker_sessions
      SET last_heartbeat_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(timestamp, timestamp, workerSessionId, input.expectedVersion ?? session.version);
    if (result.changes !== 1) throw new TeamStoreError("version_conflict", "worker session changed");
    return this.get("worker_sessions", workerSessionId);
  }

  createRun(input) {
    return this.transaction(() => {
      const session = this.get("worker_sessions", input.workerSessionId);
      if (!session) throw new TeamStoreError("not_found", "worker session not found");
      if (input.role && input.role !== session.role) {
        throw new TeamStoreError("role_mismatch", "run role must match worker session role");
      }
      if (input.runtimeKind && input.runtimeKind !== session.runtime_kind) {
        throw new TeamStoreError("runtime_mismatch", "run runtime must match worker runtime");
      }
      const recordId = input.id || id("run");
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        INSERT INTO runs(
          id, worker_session_id, work_item_id, requirement_revision_id, role,
          runtime_kind, status, started_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        input.workerSessionId,
        input.workItemId ?? session.work_item_id,
        input.requirementRevisionId ?? null,
        input.role || session.role,
        session.runtime_kind,
        input.status || "queued",
        (input.status || "queued") === "running" ? timestamp : null,
        timestamp,
        timestamp,
      );
      this.#emit(session.task_group_id, "run", recordId, "run.created", 0, {
        status: input.status || "queued",
        workerSessionId: input.workerSessionId,
        runtimeKind: session.runtime_kind,
      });
      return this.get("runs", recordId);
    });
  }

  setRunReport(runId, report, input = {}) {
    return this.transaction(() => {
      const run = this.get("runs", runId);
      if (!run) throw new TeamStoreError("not_found", "run not found");
      this.db.prepare("UPDATE runs SET report = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(json(report, {}), nowIso(this.now), runId);
      const session = this.get("worker_sessions", run.worker_session_id);
      const updated = this.get("runs", runId);
      this.#emit(session.task_group_id, "run", runId, "run.report_saved", updated.version, {
        actor: input.actor || "worker",
        source: input.source || "codex_adapter",
      });
      return updated;
    });
  }

  transition(table, recordId, input) {
    if (!STATE_TABLES.has(table)) throw new TeamStoreError("invalid_input", "unsupported state table");
    requireVersion(input?.expectedVersion);
    requireText(input?.status, "status");
    return this.transaction(() => {
      const current = this.get(table, recordId);
      if (!current) throw new TeamStoreError("not_found", `${table} record not found`);
      if (current.version !== input.expectedVersion) {
        throw new TeamStoreError("version_conflict", `${table} version conflict`, {
          expectedVersion: input.expectedVersion,
          actualVersion: current.version,
        });
      }
      this.#validateTransition(table, current, input.status);
      const timestamp = nowIso(this.now);
      const extra = table === "task_groups"
        ? ", completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END"
        : table === "worker_sessions"
          ? ", closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END"
          : table === "runs"
            ? ", started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END, ended_at = CASE WHEN ? IN ('reported','interrupted','failed','passed') THEN ? ELSE ended_at END"
            : "";
      const params = [input.status, timestamp];
      if (table === "task_groups" || table === "worker_sessions") {
        params.push(input.status, timestamp);
      } else if (table === "runs") {
        params.push(input.status, timestamp, input.status, timestamp);
      }
      params.push(recordId, input.expectedVersion);
      const result = this.db.prepare(`
        UPDATE ${table}
        SET status = ?, updated_at = ?, version = version + 1${extra}
        WHERE id = ? AND version = ?
      `).run(...params);
      if (result.changes !== 1) throw new TeamStoreError("version_conflict", `${table} changed`);
      const updated = this.get(table, recordId);
      const taskGroupId = table === "task_groups"
        ? recordId
        : table === "runs"
          ? this.get("worker_sessions", current.worker_session_id).task_group_id
          : current.task_group_id;
      const aggregateType = table.slice(0, -1);
      this.#emit(taskGroupId, aggregateType, recordId, `${aggregateType}.status_changed`, updated.version, {
        from: current.status,
        to: input.status,
        reason: input.reason ?? null,
        actor: input.actor || "orchestrator",
        source: input.source || "task_orchestrator",
      });
      return updated;
    });
  }

  #validateTransition(table, current, nextStatus) {
    if (table === "work_items" && nextStatus === "closed") {
      const passed = this.db.prepare(`
        SELECT 1 FROM acceptances
        WHERE scope = 'work_item' AND scope_id = ? AND result = 'passed'
        LIMIT 1
      `).get(current.id);
      if (!passed) throw new TeamStoreError(
        "acceptance_required",
        "work item cannot close without passed acceptance",
      );
    }
    if (table === "task_groups" && nextStatus === "done") {
      const unfinished = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM work_items
        WHERE task_group_id = ? AND status NOT IN ('closed','stale','canceled')
      `).get(current.id).count);
      const unaccepted = Number(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM requirements r
        JOIN requirement_revisions rr ON rr.requirement_id = r.id AND rr.status = 'active'
        WHERE r.task_group_id = ? AND r.status <> 'canceled'
          AND NOT EXISTS (
            SELECT 1 FROM acceptances a
            WHERE a.scope = 'requirement' AND a.scope_id = rr.id AND a.result = 'passed'
          )
      `).get(current.id).count);
      if (unfinished || unaccepted) throw new TeamStoreError(
        "task_group_incomplete",
        "task group cannot finish before all work and current requirements pass",
        { unfinished, unaccepted },
      );
    }
    if (table === "runs" && nextStatus === "passed" && current.role === "worker") {
      throw new TeamStoreError("reviewer_required", "worker run cannot pass its own work");
    }
  }

  updateTaskGroupStatus(id, input) {
    return this.transition("task_groups", id, input);
  }

  updateWorkItemStatus(id, input) {
    return this.transition("work_items", id, input);
  }

  updateWorkerSessionStatus(id, input) {
    return this.transition("worker_sessions", id, input);
  }

  updateRunStatus(id, input) {
    return this.transition("runs", id, input);
  }

  acquireWorkItemLease(input) {
    requireText(input?.workItemId, "workItemId");
    requireText(input?.workerSessionId, "workerSessionId");
    const timestamp = input.now || nowIso(this.now);
    const expiresAt = input.expiresAt || new Date(
      new Date(timestamp).getTime() + (input.ttlMs ?? 30_000),
    ).toISOString();
    const token = input.token || id("lease");
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO work_item_leases(
          work_item_id, worker_session_id, token, expires_at, acquired_at, renewed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_item_id) DO UPDATE SET
          worker_session_id = excluded.worker_session_id,
          token = excluded.token,
          expires_at = excluded.expires_at,
          acquired_at = excluded.acquired_at,
          renewed_at = excluded.renewed_at
        WHERE work_item_leases.expires_at <= ?
           OR work_item_leases.worker_session_id = excluded.worker_session_id
      `).run(
        input.workItemId,
        input.workerSessionId,
        token,
        expiresAt,
        timestamp,
        timestamp,
        timestamp,
      );
      if (result.changes !== 1) {
        throw new TeamStoreError("lease_conflict", "work item already has an active lease");
      }
      return { workItemId: input.workItemId, workerSessionId: input.workerSessionId, token, expiresAt };
    });
  }

  renewWorkItemLease({ workItemId, token, expiresAt, ttlMs = 30_000, now }) {
    const timestamp = now || nowIso(this.now);
    const nextExpiry = expiresAt || new Date(new Date(timestamp).getTime() + ttlMs).toISOString();
    const result = this.db.prepare(`
      UPDATE work_item_leases SET expires_at = ?, renewed_at = ?
      WHERE work_item_id = ? AND token = ? AND expires_at > ?
    `).run(nextExpiry, timestamp, workItemId, token, timestamp);
    if (result.changes !== 1) throw new TeamStoreError("lease_lost", "lease is absent or expired");
    return { workItemId, token, expiresAt: nextExpiry };
  }

  releaseWorkItemLease(workItemId, token) {
    return this.db.prepare(
      "DELETE FROM work_item_leases WHERE work_item_id = ? AND token = ?",
    ).run(workItemId, token).changes === 1;
  }

  acquireResourceLock(input) {
    requireText(input?.resourceKey, "resourceKey");
    const timestamp = input.now || nowIso(this.now);
    const expiresAt = input.expiresAt || new Date(
      new Date(timestamp).getTime() + (input.ttlMs ?? 30_000),
    ).toISOString();
    const token = input.token || id("lock");
    const result = this.db.prepare(`
      INSERT INTO resource_locks(
        resource_key, task_group_id, work_item_id, worker_session_id,
        token, expires_at, acquired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_key) DO UPDATE SET
        task_group_id = excluded.task_group_id,
        work_item_id = excluded.work_item_id,
        worker_session_id = excluded.worker_session_id,
        token = excluded.token,
        expires_at = excluded.expires_at,
        acquired_at = excluded.acquired_at
      WHERE resource_locks.expires_at <= ?
         OR resource_locks.worker_session_id = excluded.worker_session_id
    `).run(
      input.resourceKey,
      input.taskGroupId,
      input.workItemId,
      input.workerSessionId,
      token,
      expiresAt,
      timestamp,
      timestamp,
    );
    if (result.changes !== 1) {
      throw new TeamStoreError("resource_locked", `resource ${input.resourceKey} is locked`);
    }
    return { resourceKey: input.resourceKey, token, expiresAt };
  }

  releaseResourceLock(resourceKey, token) {
    return this.db.prepare(
      "DELETE FROM resource_locks WHERE resource_key = ? AND token = ?",
    ).run(resourceKey, token).changes === 1;
  }

  saveCheckpoint(input) {
    return this.transaction(() => {
      const recordId = input.id || id("cp");
      const timestamp = nowIso(this.now);
      this.db.prepare(`
        INSERT INTO checkpoints(
          id, task_group_id, work_item_id, worker_session_id, run_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        input.taskGroupId,
        input.workItemId ?? null,
        input.workerSessionId ?? null,
        input.runId ?? null,
        json(input.payload, {}),
        timestamp,
      );
      if (input.workerSessionId) {
        this.db.prepare(`
          UPDATE worker_sessions
          SET context_checkpoint_id = ?, updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(recordId, timestamp, input.workerSessionId);
      }
      this.#emit(input.taskGroupId, "checkpoint", recordId, "checkpoint.saved", null, {
        workItemId: input.workItemId ?? null,
        workerSessionId: input.workerSessionId ?? null,
      });
      return this.get("checkpoints", recordId);
    });
  }

  addEvidence(input) {
    return this.transaction(() => {
      const recordId = input.id || id("ev");
      this.db.prepare(`
        INSERT INTO evidence(
          id, task_group_id, work_item_id, run_id, type, source, command, exit_code,
          output_path, artifact_path, content_hash, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        input.taskGroupId,
        input.workItemId ?? null,
        input.runId ?? null,
        requireText(input.type, "type"),
        requireText(input.source, "source"),
        input.command ?? null,
        input.exitCode ?? null,
        input.outputPath ?? null,
        input.artifactPath ?? null,
        input.contentHash ?? null,
        json(input.metadata, {}),
        nowIso(this.now),
      );
      this.#emit(input.taskGroupId, "evidence", recordId, "evidence.created", null, {
        workItemId: input.workItemId ?? null,
        type: input.type,
      });
      return this.get("evidence", recordId);
    });
  }

  addAcceptance(input) {
    const evidenceIds = input?.evidenceIds || [];
    if (input?.result === "passed" && evidenceIds.length === 0) {
      throw new TeamStoreError("evidence_required", "passed acceptance requires evidence");
    }
    return this.transaction(() => {
      const targetTable = {
        work_item: "work_items",
        requirement: "requirement_revisions",
        task_group: "task_groups",
      }[input.scope];
      const target = targetTable && this.get(targetTable, input.scopeId);
      if (!target) throw new TeamStoreError("invalid_scope", "acceptance scope target not found");
      const targetTaskGroupId = input.scope === "task_group"
        ? target.id
        : input.scope === "requirement"
          ? this.get("requirements", target.requirement_id)?.task_group_id
          : target.task_group_id;
      if (targetTaskGroupId !== input.taskGroupId) {
        throw new TeamStoreError("invalid_scope", "acceptance target belongs to another task group");
      }
      for (const evidenceId of evidenceIds) {
        const evidence = this.get("evidence", evidenceId);
        if (!evidence || evidence.task_group_id !== input.taskGroupId) {
          throw new TeamStoreError("invalid_evidence", `evidence ${evidenceId} is unavailable`);
        }
      }
      if (input.result === "passed" && input.verifiedByRunId) {
        const run = this.get("runs", input.verifiedByRunId);
        if (!run || !["reviewer", "integrator"].includes(run.role) || run.status !== "passed") {
          throw new TeamStoreError(
            "reviewer_required",
            "passing acceptance requires a passed reviewer run",
          );
        }
        if (input.scope === "work_item" && run.work_item_id !== input.scopeId) {
          throw new TeamStoreError("invalid_verifier", "reviewer run targets another work item");
        }
      }
      if (input.scope === "work_item" && input.result === "passed" && !input.verifiedByRunId) {
        throw new TeamStoreError(
          "reviewer_required",
          "passing work item acceptance requires reviewer run",
        );
      }
      const recordId = input.id || id("acc");
      this.db.prepare(`
        INSERT INTO acceptances(
          id, task_group_id, scope, scope_id, criteria, result,
          evidence_ids, failure_reason, verified_by_run_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        input.taskGroupId,
        input.scope,
        input.scopeId,
        json(input.criteria, []),
        input.result,
        json(evidenceIds, []),
        input.failureReason ?? null,
        input.verifiedByRunId ?? null,
        nowIso(this.now),
      );
      this.#emit(input.taskGroupId, "acceptance", recordId, "acceptance.recorded", null, {
        scope: input.scope,
        scopeId: input.scopeId,
        result: input.result,
      });
      return this.get("acceptances", recordId);
    });
  }

  addArtifact(input) {
    const recordId = input.id || id("artifact");
    this.db.prepare(`
      INSERT INTO artifacts(
        id, task_group_id, work_item_id, evidence_id, kind, path,
        content_hash, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId,
      input.taskGroupId,
      input.workItemId ?? null,
      input.evidenceId ?? null,
      requireText(input.kind, "kind"),
      requireText(input.path, "path"),
      input.contentHash ?? null,
      input.sizeBytes ?? null,
      nowIso(this.now),
    );
    return this.get("artifacts", recordId);
  }

  updateRequirementStatus(requirementId, status, input = {}) {
    return this.transaction(() => {
      const requirement = this.get("requirements", requirementId);
      if (!requirement) throw new TeamStoreError("not_found", "requirement not found");
      this.db.prepare("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, nowIso(this.now), requirementId);
      this.#emit(requirement.task_group_id, "requirement", requirementId, "requirement.status_changed", null, {
        from: requirement.status,
        to: status,
        actor: input.actor || "orchestrator",
        source: input.source || "task_orchestrator",
      });
      return this.get("requirements", requirementId);
    });
  }

  completeDemandEvent(eventKey, result, input = {}) {
    return this.transaction(() => {
      const event = hydrate(this.db.prepare("SELECT * FROM demand_events WHERE event_key = ?").get(eventKey));
      if (!event) throw new TeamStoreError("not_found", "demand event not found");
      this.db.prepare("UPDATE demand_events SET processed_at = ?, result_json = ? WHERE event_key = ?")
        .run(nowIso(this.now), json(result, {}), eventKey);
      this.#emit(event.task_group_id, "demand_event", event.id, "demand_event.processed", null, {
        actor: input.actor || "orchestrator",
        source: input.source || "task_orchestrator",
        status: result?.status || null,
      });
      return hydrate(this.db.prepare("SELECT * FROM demand_events WHERE event_key = ?").get(eventKey));
    });
  }

  pendingOutbox(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM outbox
      WHERE published_at IS NULL AND attempts < 3
      ORDER BY id LIMIT ?
    `).all(Math.max(1, Number(limit) || 100)).map(hydrate);
  }

  markOutboxPublished(outboxId, publishedAt = nowIso(this.now)) {
    return this.db.prepare(`
      UPDATE outbox SET published_at = ?, attempts = attempts + 1, last_error = NULL
      WHERE id = ? AND published_at IS NULL
    `).run(publishedAt, outboxId).changes === 1;
  }

  markOutboxFailed(outboxId, error) {
    return this.db.prepare(`
      UPDATE outbox SET attempts = attempts + 1, last_error = ?
      WHERE id = ? AND published_at IS NULL
    `).run(String(error), outboxId).changes === 1;
  }

  recover({ staleBefore = nowIso(this.now) } = {}) {
    return this.transaction(() => {
      const staleRuns = this.db.prepare(`
        SELECT r.*, ws.task_group_id
        FROM runs r JOIN worker_sessions ws ON ws.id = r.worker_session_id
        WHERE r.status = 'running'
          AND (ws.last_heartbeat_at IS NULL OR ws.last_heartbeat_at < ?)
      `).all(staleBefore);
      const affectedWorkItems = new Set();
      for (const run of staleRuns) {
        const session = this.get("worker_sessions", run.worker_session_id);
        const workItem = run.work_item_id ? this.get("work_items", run.work_item_id) : null;
        this.db.prepare(`
          UPDATE runs SET status = 'interrupted', ended_at = ?, updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(nowIso(this.now), nowIso(this.now), run.id);
        this.db.prepare(`
          UPDATE worker_sessions
          SET status = 'lost', updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(nowIso(this.now), run.worker_session_id);
        let workItemChanged = false;
        if (run.work_item_id) {
          workItemChanged = this.db.prepare(`
            UPDATE work_items
            SET status = 'ready', updated_at = ?, version = version + 1
            WHERE id = ? AND status IN ('assigned','running','reported','verifying')
          `).run(nowIso(this.now), run.work_item_id).changes === 1;
          this.db.prepare("DELETE FROM work_item_leases WHERE work_item_id = ?")
            .run(run.work_item_id);
          if (workItemChanged) affectedWorkItems.add(run.work_item_id);
        }
        this.db.prepare("DELETE FROM resource_locks WHERE worker_session_id = ?")
          .run(run.worker_session_id);
        this.#emit(run.task_group_id, "run", run.id, "run.interrupted", run.version + 1, {
          reason: "stale_heartbeat",
        });
        this.#emit(
          run.task_group_id,
          "worker_session",
          run.worker_session_id,
          "worker_session.status_changed",
          session.version + 1,
          { from: session.status, to: "lost", reason: "stale_heartbeat" },
        );
        if (workItem && workItemChanged) {
          this.#emit(
            run.task_group_id,
            "work_item",
            run.work_item_id,
            "work_item.status_changed",
            workItem.version + 1,
            { from: workItem.status, to: "ready", reason: "worker_lost" },
          );
        }
      }
      this.db.prepare("DELETE FROM work_item_leases WHERE expires_at <= ?").run(staleBefore);
      this.db.prepare("DELETE FROM resource_locks WHERE expires_at <= ?").run(staleBefore);
      return { interruptedRuns: staleRuns.length, readyWorkItems: [...affectedWorkItems] };
    });
  }
}
