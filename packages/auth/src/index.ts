import NextAuth, { type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@agentrail/db-postgres";
import {
  users,
  accounts,
  sessions,
  verificationTokens,
  persistGithubAccountTokens,
} from "@agentrail/db-postgres";

/**
 * Full `repo` on top of whatever identity scopes GitHub grants the App's
 * login OAuth by default. Passed as the `authorizationParams.scope` when a
 * user escalates at connect/create-repo time so the stored OAuth token can
 * list private repos, push branches, open PRs and create issues for the
 * GitHub connector (see the console's repos connect flow, `signIn`'s
 * `authorizationParams` override). `repo` (not `public_repo`) because the
 * connector must reach private repositories too. Unrelated to Jace's own repo
 * access, which comes exclusively from the workspace's App installation
 * (installation tokens) — this scope only widens the user's own login token
 * for the separate GitHub connector feature.
 */
export const GITHUB_REPO_SCOPE = "read:user user:email repo";

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
    // Persist the freshest GitHub token + granted scope on every GitHub sign-in.
    // Auth.js writes the accounts row only once (first link via linkAccount) and
    // does NOT update it on later sign-ins, so a scope ESCALATION
    // (identity-only -> repo, #1294) would otherwise never reach the DB. On a
    // brand-new sign-in the row does not exist yet — this updates 0 rows and the
    // adapter's linkAccount inserts it; on a re-auth/escalation it refreshes the
    // stored token + scope. Wrapped so a persistence hiccup never blocks login.
    async signIn({ account }) {
      if (account?.provider === "github" && account.providerAccountId) {
        try {
          await persistGithubAccountTokens({
            providerAccountId: account.providerAccountId,
            access_token: account.access_token,
            scope: account.scope,
            token_type: account.token_type,
            expires_at: account.expires_at,
            refresh_token: account.refresh_token,
          });
        } catch (err) {
          console.error(
            "[auth] failed to persist GitHub account tokens on sign-in",
            err
          );
        }
      }
      return true;
    },
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
