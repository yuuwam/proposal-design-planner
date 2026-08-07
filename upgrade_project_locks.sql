CREATE TABLE IF NOT EXISTS project_locks (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  locked_by_user_id TEXT NOT NULL,
  locked_by_email TEXT,
  locked_by_name TEXT,
  client_id TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_locks_expires ON project_locks(expires_at);

DELETE FROM project_locks WHERE expires_at<=datetime('now');
