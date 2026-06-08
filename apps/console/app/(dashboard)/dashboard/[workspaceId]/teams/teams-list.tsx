"use client";

import { useEffect, useState } from "react";

interface Team {
  id: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export function TeamsList({ workspaceId }: { workspaceId: string }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/teams`)
      .then((r) => r.json())
      .then((data) => {
        setTeams(data.teams ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
        ))}
      </div>
    );
  }

  if (teams.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--gray-09)]">No teams found.</p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
            <th className="px-3 py-2">Team Name</th>
            <th className="px-3 py-2 text-right">Members</th>
            <th className="px-3 py-2">Created</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((team) => (
            <tr key={team.id} className="border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]">
              <td className="px-3 py-2 text-sm font-medium text-[var(--gray-12)]">
                {team.name}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-12)]">
                {team.memberCount}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                {new Date(team.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
