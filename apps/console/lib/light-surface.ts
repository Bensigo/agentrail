import type { CSSProperties } from "react";

/** Light token surface for the FRONT-DOOR pages (landing + auth).
 *
 *  The app shell (app/layout.tsx) defaults `<html>` to light, but the
 *  dashboard's theme toggle persists a "dark" preference to localStorage for
 *  the whole app (one shared `<html>` element, see app/layout.tsx's inline
 *  script). A visitor who toggled dark in the console and later lands on
 *  "/" or "/login" would otherwise see a dark front door. TASTE.md mandates
 *  these pages always read light — they are Jace's face, not a themeable
 *  console surface — so each re-establishes the documented `:root` token
 *  values on its subtree regardless of the toggle. These are the exact
 *  light values from globals.css, not new colors. Everything inside
 *  (including <ConversationDemo/>) inherits them via the CSS
 *  custom-property cascade.
 *
 *  Moved out of (marketing)/page.tsx when the auth pages joined the design
 *  system (auth-v2) — one definition, two front doors. */
export const LIGHT_SURFACE: CSSProperties = {
  colorScheme: "light",
  ["--gray-00" as string]: "#ffffff",
  ["--gray-01" as string]: "#fcfcfc",
  ["--gray-02" as string]: "#f9f9f9",
  ["--gray-03" as string]: "#f0f0f0",
  ["--gray-04" as string]: "#e8e8e8",
  ["--gray-05" as string]: "#e0e0e0",
  ["--gray-06" as string]: "#d9d9d9",
  ["--gray-07" as string]: "#cecece",
  ["--gray-08" as string]: "#bbbbbb",
  ["--gray-09" as string]: "#8d8d8d",
  ["--gray-10" as string]: "#838383",
  ["--gray-11" as string]: "#646464",
  ["--gray-12" as string]: "#202020",
  ["--gray-13" as string]: "#0c0c0c",
  ["--blue-11" as string]: "#0d74ce",
  ["--green-11" as string]: "#208368",
  ["--red-11" as string]: "#ce2c31",
  ["--orange-11" as string]: "#cc4e00",
  ["--yellow-11" as string]: "#9e6c00",
  ["--purple-11" as string]: "#6550b9",
  ["--teal-11" as string]: "#008573",
  ["--brand-accent" as string]: "#ffe629",
  ["--accent-text" as string]: "#0c0c0c",
  ["--accent-fill" as string]: "#ffe629",
  ["--accent-fill-text" as string]: "#0c0c0c",
  ["--accent-fill-hover" as string]: "#ffdc00",
  ["--paper" as string]: "#fffbea",
} as CSSProperties;
