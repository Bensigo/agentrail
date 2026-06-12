import { listWorkspaceTeams } from "@agentrail/db-postgres";

export async function TeamsSection({ workspaceId }: { workspaceId: string }) {
  let teams: Awaited<ReturnType<typeof listWorkspaceTeams>> = [];
  try {
    teams = await listWorkspaceTeams(workspaceId);
  } catch {
    // DB unavailable
  }

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Teams</h2>

      {teams.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-sm text-[var(--gray-09)]">
          No teams in this workspace yet.
        </div>
      ) : (
        <div className="rounded border border-[var(--gray-05)] overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Team
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Members
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Repositories
                </th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr
                  key={team.id}
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5">
                    <span className="text-[var(--gray-12)] font-medium text-xs">
                      {team.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-xs text-[var(--gray-11)]">
                      {team.memberCount}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    {team.repositories.length === 0 ? (
                      <span className="text-xs text-[var(--gray-08)]">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {team.repositories.map((repo) => (
                          <span
                            key={repo}
                            className="font-mono text-xs text-[var(--gray-10)] bg-[var(--gray-03)] px-1.5 py-0.5 rounded-sm"
                          >
                            {repo}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
