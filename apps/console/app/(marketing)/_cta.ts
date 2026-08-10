/**
 * The landing page's acquisition CTA. `/login` is the public entry point
 * configured by NextAuth; after GitHub sign-in, the root route sends new
 * users without a workspace to `/setup`.
 */
export const LANDING_CTA = {
  href: "/login",
  label: "Add Jace to your project",
} as const;

export type LandingCta = typeof LANDING_CTA;
