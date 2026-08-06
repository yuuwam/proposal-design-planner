CREATE TABLE IF NOT EXISTS collab_presence (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  user_email TEXT,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_presence_project ON collab_presence(workspace_id, project_id, last_seen);
