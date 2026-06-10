import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { listWorkspacesForUser, createWorkspace } from "@agentrail/db-postgres";

export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as typeof session.user & { id?: string }).id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaces = await listWorkspacesForUser(userId);

  return NextResponse.json(
    workspaces.map(({ id, name, slug, role }) => ({ id, name, slug, role }))
  );
}

const SLUG_RE = /^[a-z0-9-]{2,32}$/;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as typeof session.user & { id?: string }).id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as {
    name?: unknown;
    slug?: unknown;
  };

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";

  if (!name) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", field: "name", message: "name is required" } },
      { status: 400 }
    );
  }
  if (name.length > 80) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", field: "name", message: "name must be 80 characters or fewer" } },
      { status: 400 }
    );
  }
  if (!slug) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", field: "slug", message: "slug is required" } },
      { status: 400 }
    );
  }
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          field: "slug",
          message: "slug must be 2–32 characters and contain only lowercase letters, digits, and hyphens",
        },
      },
      { status: 400 }
    );
  }

  try {
    const workspace = await createWorkspace({ name, slug, userId });
    return NextResponse.json(
      { id: workspace.id, name: workspace.name, slug: workspace.slug },
      { status: 201 }
    );
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      return NextResponse.json(
        { error: { code: "SLUG_CONFLICT", field: "slug", message: "A workspace with this slug already exists" } },
        { status: 409 }
      );
    }
    throw err;
  }
}
