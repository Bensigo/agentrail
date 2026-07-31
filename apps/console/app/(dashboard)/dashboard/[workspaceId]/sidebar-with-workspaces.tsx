import { Sidebar } from "../../../components/sidebar";
import { getWorkspacesForUser } from "../../../../lib/cached";

// Extracted out of `layout.tsx` (2026-07-31 hotfix): the App Router ignores
// extra named exports from a `layout.tsx` at RUNTIME, but `next build`'s
// generated route-type validation (`.next/types/.../layout.ts`) rejects them
// with a TS2344 constraint failure — a layout file may carry only its
// default export plus a small sanctioned set (`metadata`, `generateMetadata`,
// etc.), none of which `SidebarWithWorkspaces` is. `vitest` and a `tsc
// --noEmit` run without freshly-generated `.next/types` both stay green
// regardless, which is how this shipped in slice 6 unnoticed — it only
// surfaces once `.next/types` actually regenerates (a real `next dev`/`next
// build`, or a browser-verify step that boots one). Same bug class, same fix
// shape as the `route.ts` version of this (commit 403920ea,
// `published-helpers.ts`): a component/helper that wants a named export
// lives beside the route/layout, never inside it.

type SidebarUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

// Streams in the workspace list for the switcher without blocking the page
// shell: the surrounding Suspense fallback renders the full sidebar (nav,
// user, sign-out) immediately with an empty switcher.
export async function SidebarWithWorkspaces({
  userId,
  workspaceId,
  user,
  signOutAction,
  chatEnabled,
  goalsEnabled,
}: {
  userId: string;
  workspaceId: string;
  user: SidebarUser;
  signOutAction: () => Promise<void>;
  chatEnabled: boolean;
  goalsEnabled: boolean;
}) {
  const workspaces = await getWorkspacesForUser(userId);
  return (
    <Sidebar
      workspaces={workspaces}
      workspaceId={workspaceId}
      user={user}
      signOutAction={signOutAction}
      chatEnabled={chatEnabled}
      goalsEnabled={goalsEnabled}
    />
  );
}
