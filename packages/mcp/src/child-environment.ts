/** Keep workflow credentials out of repository-controlled subprocesses. */
export function agentrailChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child = { ...source };
  delete child.AGENTRAIL_MCP_CORRECTION_API_KEY;
  delete child.AGENTRAIL_MCP_JACE_API_KEY;
  delete child.AGENTRAIL_WORKFLOW_API_KEY;
  delete child.AGENTRAIL_WORKFLOW_RELEASE_API_KEY;
  return child;
}
