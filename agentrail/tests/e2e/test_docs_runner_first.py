"""AgentRail documentation contract after the owner-approved repository split."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / "apps/console/content/docs"

def test_readme_documents_any_mcp_agent_and_shared_console():
    text = (ROOT / "README.md").read_text()
    assert "any MCP-compatible coding agent" in text
    assert "workflow_start" in text and "workflow_get" in text
    assert "workflow_start" in text[:text.index("## Optional native workflow")]
    assert "agentrail login" in text and "agentrail runner" in text

def test_quickstart_does_not_require_jace():
    text = (DOCS / "getting-started/quickstart.mdx").read_text()
    assert "workflow_start" in text and "workflow_check" in text
    assert "Message Jace" not in text and "message Jace" not in text
    assert "AGENTRAIL_WORKFLOW_API_KEY" in text

def test_mcp_documents_report_and_human_boundaries():
    text = (ROOT / "packages/mcp/README.md").read_text()
    assert "only a human can close/reopen" in text
    assert "agent-reported" in text and "private-context access" in text
    assert "AGENTRAIL_MCP_JACE_API_KEY" not in text

def test_cli_package_keeps_native_runner_setup():
    text = (ROOT / "npm-README.md").read_text()
    assert "agentrail login" in text and "agentrail runner" in text
