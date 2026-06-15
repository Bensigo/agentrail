"use client";

import { useState } from "react";
import { AgentBreakdown } from "./agent-breakdown";
import { CostAnomalyTable } from "./cost-anomaly-table";
import { CostsTable } from "./costs-table";
import type { TimeRange } from "./cost-filters";
import { SavingsPanel } from "./savings-panel";

interface CostsClientProps {
  workspaceId: string;
}

export function CostsClient({ workspaceId }: CostsClientProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("");

  const handleTimeRangeToggle = (range: TimeRange) => {
    setTimeRange((current) => (current === range ? "" : range));
  };

  return (
    <div className="flex flex-col gap-6">
      <CostsTable
        workspaceId={workspaceId}
        timeRange={timeRange}
        onTimeRangeToggle={handleTimeRangeToggle}
      />
      <SavingsPanel workspaceId={workspaceId} timeRange={timeRange} />
      <AgentBreakdown workspaceId={workspaceId} timeRange={timeRange} />
      <CostAnomalyTable workspaceId={workspaceId} timeRange={timeRange} />
    </div>
  );
}
