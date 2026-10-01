// Central definition of "corporate" email domains. A model call is treated as
// "shadow AI" when it comes from an authenticated user whose email is NOT on one
// of these domains. The value is a module-level variable so the synchronous DQL
// builders in normalize.ts/queries.ts can read it; SettingsProvider hydrates it
// from App State at startup and on change (see data/settings.tsx).

/** Fallback when nothing is persisted in App State. */
export const DEFAULT_CORPORATE_DOMAINS = ["dynatrace.com"];

/** App State key under which the configured domains are persisted. */
export const CORPORATE_DOMAINS_STATE_KEY = "corporateDomains";

let corporateDomains: string[] = [...DEFAULT_CORPORATE_DOMAINS];

/** Fallback output-token threshold below which an Opus turn is flagged "trivial". */
export const DEFAULT_OPUS_TRIVIAL_OUTPUT_TOKENS = 300;

/** App State key under which the configured threshold is persisted. */
export const OPUS_TRIVIAL_OUTPUT_TOKENS_STATE_KEY = "opusTrivialOutputTokens";

let opusTrivialOutputTokens: number = DEFAULT_OPUS_TRIVIAL_OUTPUT_TOKENS;

/** Trim, lowercase, strip a leading '@', and drop empties/duplicates. */
export function normalizeDomains(domains: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of domains) {
    const d = String(raw).trim().toLowerCase().replace(/^@+/, "");
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

export function getCorporateDomains(): string[] {
  return corporateDomains;
}

/** Set the in-memory domains (called by SettingsProvider). Not persisted here. */
export function setCorporateDomainsModule(domains: string[]): void {
  corporateDomains = normalizeDomains(domains);
}

export function getOpusTrivialOutputTokens(): number {
  return opusTrivialOutputTokens;
}

/** Set the in-memory threshold (called by SettingsProvider). Not persisted here. */
export function setOpusTrivialOutputTokensModule(n: number): void {
  opusTrivialOutputTokens = Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_OPUS_TRIVIAL_OUTPUT_TOKENS;
}

/** Escape a value interpolated into a DQL double-quoted string literal. */
function escDql(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** DQL predicate: true when user.email is present and not on a corporate domain. */
export function personalEmailPredicateDQL(): string {
  if (corporateDomains.length === 0) return `isNotNull(user.email)`;
  const checks = corporateDomains.map((d) => `contains(lower(user.email), "@${escDql(d)}")`);
  return `(isNotNull(user.email) and not (${checks.join(" or ")}))`;
}

/** JS mirror of the DQL predicate for client-side classification (e.g. Tools). */
export function isPersonalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  if (corporateDomains.length === 0) return true;
  const e = email.toLowerCase();
  return !corporateDomains.some((d) => e.includes(`@${d}`));
}
