ALTER TABLE api_keys DROP CONSTRAINT api_keys_kind_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_kind_check CHECK (kind IN ('self_hosted', 'fleet', 'agent_mcp', 'workflow_mcp', 'workflow_release'));
ALTER TABLE workflow_events DROP CONSTRAINT workflow_events_kind_check;
ALTER TABLE workflow_events ADD CONSTRAINT workflow_events_kind_check CHECK (kind IN ('agent_report', 'human_decision', 'release_verifier'));
