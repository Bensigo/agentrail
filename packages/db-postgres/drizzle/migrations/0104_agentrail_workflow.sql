-- Independent AgentRail workflow; inherited Jace tables are preserved unchanged.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_kind_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_kind_check CHECK (kind IN ('self_hosted', 'fleet', 'agent_mcp', 'workflow_mcp'));
CREATE TABLE workflow_tasks (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
 task_key text NOT NULL CHECK (length(task_key) BETWEEN 1 AND 128),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 agent text NOT NULL CHECK (length(agent) BETWEEN 1 AND 100),
 branch text NOT NULL CHECK (length(branch) BETWEEN 1 AND 256),
 request_hash text NOT NULL,
 phase text NOT NULL DEFAULT 'planning' CHECK (phase IN ('planning', 'implementing', 'testing', 'reviewing', 'blocked', 'needs_review', 'closed')),
 revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
 summary text NOT NULL DEFAULT '',
 pr_url text,
 active_check_key text,
 active_check_name text,
 active_check_actor text,
 active_check_deadline timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, task_key),
 UNIQUE (workspace_id, id)
);
CREATE INDEX workflow_tasks_recent_idx ON workflow_tasks(workspace_id, updated_at DESC);
CREATE TABLE workflow_events (
 workspace_id uuid NOT NULL,
 task_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision >= 0),
 event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 128),
 kind text NOT NULL CHECK (kind IN ('agent_report', 'human_decision')),
 request_hash text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (task_id, revision),
 UNIQUE (task_id, event_key),
 FOREIGN KEY (workspace_id, task_id) REFERENCES workflow_tasks(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE workspaces ALTER COLUMN require_alignment SET DEFAULT false;
ALTER TABLE workspaces ALTER COLUMN hosted_execution SET DEFAULT false;
