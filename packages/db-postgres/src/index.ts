export { db } from "./db.js";
export * from "./schema/index.js";
export * from "./queries/index.js";
export { encryptSecret, decryptSecret, isEncrypted } from "./crypto.js";
// OAuth Connect Wave 3, W3-T1 (`.superpowers/sdd/plan-oauth.md`) — discriminates
// an already-decrypted `connectors.secret` plaintext as a legacy token or an
// OAuth credential envelope. Sibling of crypto.ts, not folded into it — see
// that file's own doc-comment.
export {
  parseSecretEnvelope,
  serializeOauthEnvelope,
  type OauthCredential,
  type ParsedSecret,
} from "./secret-envelope.js";
// #1290 prepaid-wallet pricing — the pure, customer-facing price of a
// completed task (actual token cost + two flat, tunable constants). Separate
// from `apps/console/lib/alignment/estimate.ts`'s pre-task budget cap on
// purpose; see `billing/pricing.ts`.
export {
  FLAT_SERVER_FEE_CENTS,
  FLAT_PROFIT_CENTS,
  usdToCents,
  taskPriceCents,
} from "./billing/pricing.js";
// GitHub App installation credentials (spec:
// docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md
// §5/§6). getInstallationToken is the drop-in getGithubToken replacement.
export {
  getInstallationToken,
  getGithubInstallation,
  bindWorkspaceGithubInstallation,
  mintGithubInstallState,
  consumeGithubInstallState,
  getUserGithubIdentityById,
} from "./queries/github-app-token.js";
