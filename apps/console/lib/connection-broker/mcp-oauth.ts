import { computeCodeChallengeS256 } from "../oauth/pkce";
import { registerOauthAdapter, type OauthEnvelope, type OauthProviderAdapter } from "../oauth/types";
import { connectionDefinitionFor } from "./registry";
import type { BrokerConnectorKind } from "./types";

export interface McpOauthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
}

const REMOTE_MCP_OAUTH_PROVIDERS: BrokerConnectorKind[] = [
  "linear",
  "figma",
  "context7",
  "datadog",
  "grafana",
  "vercel",
  "cloudflare",
];

const registeredProviders = new Set<string>();

function envKey(provider: string, suffix: string): string {
  return `JACE_MCP_${provider.toUpperCase()}_OAUTH_${suffix}`;
}

function envValue(provider: string, suffix: string): string | null {
  return process.env[envKey(provider, suffix)] || null;
}

function remoteMcpOauthProvider(provider: string): BrokerConnectorKind {
  const definition = connectionDefinitionFor(provider as BrokerConnectorKind);
  if (!definition || definition.mode !== "remote-mcp-oauth") {
    throw new Error(`Provider ${provider} is not a remote-mcp-oauth connector`);
  }
  return provider as BrokerConnectorKind;
}

function expiresAtFrom(payload: Record<string, unknown>): string {
  const expiresAt = payload.expires_at;
  if (typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt))) {
    return new Date(expiresAt).toISOString();
  }
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    const ms = expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
    return new Date(ms).toISOString();
  }
  const expiresIn = payload.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn >= 0) {
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }
  throw new Error("Malformed OAuth token response");
}

function oauthEnvelopeFrom(payload: unknown): OauthEnvelope {
  if (!payload || typeof payload !== "object") {
    throw new Error("Malformed OAuth token response");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new Error("Malformed OAuth token response");
  }
  if (typeof record.refresh_token !== "string" || !record.refresh_token) {
    throw new Error("Malformed OAuth token response");
  }
  return {
    access: record.access_token,
    refresh: record.refresh_token,
    expiresAt: expiresAtFrom(record),
  };
}

async function postForm(url: string, body: URLSearchParams): Promise<OauthEnvelope> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed with status ${res.status}`);
  }
  return oauthEnvelopeFrom(await res.json());
}

function adapterFor(provider: BrokerConnectorKind): OauthProviderAdapter {
  const configFor = () => {
    const config = mcpOauthConfigFor(provider);
    if (!config) {
      throw new Error(`Missing OAuth env for ${provider}: ${missingMcpOauthEnv(provider).join(", ")}`);
    }
    return config;
  };

  return {
    provider,
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      if (!codeChallenge) throw new Error("Missing PKCE code_challenge");
      const config = configFor();
      const url = new URL(config.authorizeUrl);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      if (!codeVerifier) throw new Error("Missing PKCE code_verifier");
      const config = configFor();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: codeVerifier,
      });
      return postForm(config.tokenUrl, body);
    },
    async refresh(envelope) {
      const config = configFor();
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: envelope.refresh,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      return postForm(config.tokenUrl, body);
    },
    envReady() {
      return missingMcpOauthEnv(provider).length === 0;
    },
    extraEnvKeys() {
      return [envKey(provider, "AUTHORIZE_URL"), envKey(provider, "TOKEN_URL")];
    },
  };
}

export function mcpOauthConfigFor(provider: string): McpOauthConfig | null {
  const kind = remoteMcpOauthProvider(provider);
  const clientId = envValue(kind, "CLIENT_ID");
  const clientSecret = envValue(kind, "CLIENT_SECRET");
  const authorizeUrl = envValue(kind, "AUTHORIZE_URL");
  const tokenUrl = envValue(kind, "TOKEN_URL");
  if (!clientId || !clientSecret || !authorizeUrl || !tokenUrl) return null;
  return { clientId, clientSecret, authorizeUrl, tokenUrl };
}

export function missingMcpOauthEnv(provider: string): string[] {
  const kind = remoteMcpOauthProvider(provider);
  const missing: string[] = [];
  for (const suffix of ["CLIENT_ID", "CLIENT_SECRET", "AUTHORIZE_URL", "TOKEN_URL"]) {
    const key = envKey(kind, suffix);
    if (!process.env[key]) missing.push(key);
  }
  return missing;
}

export function registerMcpOauthAdapters(): void {
  for (const provider of REMOTE_MCP_OAUTH_PROVIDERS) {
    if (connectionDefinitionFor(provider).mode !== "remote-mcp-oauth") continue;
    if (registeredProviders.has(provider)) continue;
    registerOauthAdapter(adapterFor(provider));
    registeredProviders.add(provider);
  }
}

export function mcpCodeChallengeFor(codeVerifier: string): string {
  return computeCodeChallengeS256(codeVerifier);
}

registerMcpOauthAdapters();
