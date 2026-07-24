import NextAuth, { type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@agentrail/db-postgres";
import { users, accounts, sessions, verificationTokens } from "@agentrail/db-postgres";

const result: NextAuthResult = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    GitHub({
      // The Jace GitHub App's OAuth credentials (spec
      // docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md
      // §4) — same App as the installation flow, so the consent screen says
      // "Authorize Jace". No scope override: GitHub Apps don't grant repo
      // access via login-time OAuth scopes; repo access comes exclusively
      // from the workspace's App installation (installation tokens). The
      // access_token the adapter stores is inert login plumbing — nothing
      // reads it (getGithubToken is deleted; see getInstallationToken).
      clientId: process.env["GITHUB_APP_CLIENT_ID"]!,
      clientSecret: process.env["GITHUB_APP_CLIENT_SECRET"]!,
    }),
  ],
  pages: {
    signIn: "/login",
    // Branded, plain-language failure page (denied/failed consent) with a retry
    // path back to sign-in, instead of NextAuth's unbranded default. #1294 AC3.
    error: "/auth-error",
  },
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Route to the supplied URL if it's within this app; otherwise root.
      // The root page handles workspace-aware routing to /dashboard/{id} or /setup.
      if (url.startsWith(baseUrl)) return url;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      return `${baseUrl}/`;
    },
    async session({ session, user }) {
      if (session.user && user) {
        (session.user as typeof session.user & { id: string }).id = user.id;
      }
      return session;
    },
  },
});

export const auth = result.auth;
export const handlers = result.handlers;
export const signIn = result.signIn;
export const signOut = result.signOut;
