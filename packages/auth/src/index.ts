import NextAuth, { type NextAuthResult } from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@agentrail/db-postgres";
import {
  users,
  accounts,
  sessions,
  verificationTokens,
} from "@agentrail/db-postgres";

const result: NextAuthResult = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    GitHub({
      clientId: process.env["GITHUB_CLIENT_ID"]!,
      clientSecret: process.env["GITHUB_CLIENT_SECRET"]!,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async redirect({ baseUrl }) {
      return `${baseUrl}/dashboard`;
    },
  },
});

export const auth = result.auth;
export const handlers = result.handlers;
export const signIn = result.signIn;
export const signOut = result.signOut;
