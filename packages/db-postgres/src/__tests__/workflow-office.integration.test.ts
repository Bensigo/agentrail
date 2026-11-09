import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  startWorkflowTask,
  updateWorkflowTask,
  readWorkflowOffice,
  WorkflowConflict,
} from "../queries/workflow.js";
const available = await db
  .execute(sql`SELECT to_regclass('public.workflow_tasks') AS present`)
  .then((r) => Boolean(r[0]?.present))
  .catch(() => false);
describe.skipIf(!available)(
  "Office — retained snapshots in real PostgreSQL",
  () => {
    it("keeps independent telemetry across more than 100 ordinary reports, scopes tenants and retains distinct tasks with the same agent label", async () => {
      const workspace = randomUUID(),
        foreign = randomUUID(),
        repo = randomUUID(),
        actor = randomUUID();
      try {
        await db.execute(
          sql`INSERT INTO workspaces(id,name,slug) VALUES (${workspace},'Office test',${workspace}),(${foreign},'Foreign',${foreign})`,
        );
        await db.execute(
          sql`INSERT INTO repositories(id,workspace_id,name,url) VALUES (${repo},${workspace},'owner/repo','https://github.com/owner/repo')`,
        );
        const create = () =>
          startWorkflowTask(
            workspace,
            {
              taskKey: randomUUID(),
              title: "Office proof",
              agent: "Shared label",
              repositoryId: repo,
              branch: "main",
            },
            actor,
          );
        const a = await create(),
          b = await create(),
          c = await create();
        const first = {
          eventKey: "telemetry",
          expectedRevision: 0,
          phase: "implementing" as const,
          summary: "Working",
          usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
          context: {
            summary: "Current files",
            sources: ["src/main.ts"],
            tokens: 0,
            windowTokens: 8192,
          },
        };
        await updateWorkflowTask(workspace, String(a.id), first, false, actor);
        expect(
          (
            await updateWorkflowTask(
              workspace,
              String(a.id),
              first,
              false,
              actor,
            )
          )?.replayed,
        ).toBe(true);
        await updateWorkflowTask(
          workspace,
          String(b.id),
          {
            ...first,
            usage: { costUsd: 1.25, inputTokens: 50, outputTokens: 10 },
          },
          false,
          actor,
        );
        for (let n = 1; n <= 102; n++)
          await updateWorkflowTask(
            workspace,
            String(a.id),
            {
              eventKey: `progress-${n}`,
              expectedRevision: n,
              phase: "implementing",
              summary: "Still working",
            },
            false,
            actor,
          );
        let office = await readWorkflowOffice(workspace);
        expect(office.tasks).toHaveLength(3);
        const stored = office.tasks.find((t) => t.id === a.id)!;
        expect(stored.context).toEqual(first.context);
        expect(stored.usage).toEqual(first.usage);
        expect(stored.context_at).not.toBe(stored.reported_at);
        expect(office.tasks.find((t) => t.id === c.id)!.usage).toBeNull();
        expect((await readWorkflowOffice(foreign)).tasks).toEqual([]);
        // Reports without telemetry preserve it; a full new usage snapshot replaces the cumulative value.
        await updateWorkflowTask(
          workspace,
          String(a.id),
          {
            eventKey: "new-usage",
            expectedRevision: 103,
            phase: "needs_review",
            summary: "Review",
            usage: { costUsd: 0.5, inputTokens: 100, outputTokens: 20 },
          },
          false,
          actor,
        );
        await updateWorkflowTask(
          workspace,
          String(a.id),
          {
            eventKey: "human-close",
            expectedRevision: 104,
            decision: "complete",
          },
          true,
          actor,
        );
        office = await readWorkflowOffice(workspace);
        expect(office.tasks.find((t) => t.id === a.id)!.phase).toBe("closed");
        await updateWorkflowTask(
          workspace,
          String(a.id),
          { eventKey: "reopen", expectedRevision: 105, decision: "reopen" },
          true,
          actor,
        );
        const reopened = (await readWorkflowOffice(workspace)).tasks.find(
          (t) => t.id === a.id,
        )!;
        expect(reopened.phase).toBe("planning");
        expect(reopened.reported_phase).toBe("needs_review");
        await db.execute(sql`INSERT INTO workflow_tasks(id,workspace_id,repository_id,task_key,title,agent,branch,request_hash,phase)
        SELECT gen_random_uuid(),${workspace},${repo},'closed-'||n,'Closed fixture','Shared label','main','fixture','closed' FROM generate_series(1,105) n`);
        const bounded = await readWorkflowOffice(workspace);
        expect(bounded.tasks).toHaveLength(100);
        expect(bounded.tasks.some((t) => t.id === a.id)).toBe(true);
        expect(bounded.tasks.some((t) => t.id === c.id)).toBe(true);
        expect(office.tasks.find((t) => t.id === a.id)!.usage).toEqual({
          costUsd: 0.5,
          inputTokens: 100,
          outputTokens: 20,
        });
        // A telemetry update cannot interrupt a configured check reservation.
        await updateWorkflowTask(
          workspace,
          String(b.id),
          {
            eventKey: "check",
            expectedRevision: 1,
            phase: "testing",
            summary: "Checking",
            checkReservation: { name: "test" },
          },
          false,
          actor,
        );
        await expect(
          updateWorkflowTask(
            workspace,
            String(b.id),
            { ...first, eventKey: "interrupt", expectedRevision: 2 },
            false,
            actor,
          ),
        ).rejects.toBeInstanceOf(WorkflowConflict);
      } finally {
        await db.execute(
          sql`DELETE FROM workflow_tasks WHERE workspace_id IN (${workspace},${foreign})`,
        );
        await db.execute(
          sql`DELETE FROM repositories WHERE workspace_id=${workspace}`,
        );
        await db.execute(
          sql`DELETE FROM workspaces WHERE id IN (${workspace},${foreign})`,
        );
      }
    });
  },
);
