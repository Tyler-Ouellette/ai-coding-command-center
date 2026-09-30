// Canonical secret/credential/destructive/jailbreak pattern definitions for
// the Security & governance flags (see FEATURES.md "Flag secrets in prompts
// and commands"). Both the DQL aggregation in queries.ts and the client-side
// per-span checks in SessionDetail.tsx build from these lists, so a new rule
// only has to be added once here to cover the Overview strip, the drill-down
// sheet, the deep-link span highlighter, and the inline trace-row warnings.
//
// Each pattern carries TWO independent matchers:
//
//  1. `all` — one or more regex sources (ALL must match — AND) tested against
//     an already-lowercased haystack by a precompiled JS RegExp (`re`). This
//     is the PRECISE, exact client-side check used by SessionDetail.tsx and
//     the deep-link span highlighter. Patterns may use character classes,
//     quantifiers, alternation, \s/\S — no lookaround or backreferences.
//
//  2. `dql` — one or more LOWERCASE LITERAL substrings (ALL must be present —
//     AND, mirroring how `all` regexes are AND-ed) used by the Grail/DQL
//     aggregation in queries.ts. Dynatrace DQL's matchesPattern() is NOT a
//     regex function — it parses DPL (Dynatrace Pattern Language) and rejects
//     regex tokens such as `_`, `[a-z0-9]{20,}`, etc. (verified live: such
//     queries fail with ERROR_IN_PARSING_PATTERN), and DQL has no drop-in
//     regex-boolean function. So the DQL side is a COARSE contains()-anchor
//     PREFILTER: it AND-matches these literal anchors against the lowercased
//     haystack (the query wraps the field in lower(...), hence anchors must be
//     lowercase). It is deliberately looser than the JS regex — some anchors
//     trade a little recall/precision for a valid, cheap query — while the
//     exact match still runs client-side via `re`. This contains() approach
//     is validated against the tenant.

export interface SecurityPattern {
  id: string;
  label: string;
  /** Regex sources; ALL must match the haystack (AND). Usually a single entry. */
  all: string[];
  /** Precompiled, same order as `all`. */
  re: RegExp[];
  /**
   * Lowercase literal substrings for the DQL contains()-anchor prefilter;
   * ALL must be present in the (already-lowercased) haystack (AND). Coarser
   * than `all`/`re` — the exact regex still runs client-side.
   */
  dql: string[];
}

function pattern(id: string, label: string, dql: string[], ...all: string[]): SecurityPattern {
  return { id, label, all, re: all.map((s) => new RegExp(s)), dql };
}

/** Escape a literal/string for embedding in a DQL double-quoted string literal. */
function dqlStringLiteral(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** True when every regex in the pattern matches the (already-lowercased) haystack. */
function patternMatches(p: SecurityPattern, hayLower: string): boolean {
  return p.re.every((re) => re.test(hayLower));
}

/** True when any pattern in the list matches the haystack. */
export function matchesAny(patterns: SecurityPattern[], hayLower: string): boolean {
  return patterns.some((p) => patternMatches(p, hayLower));
}

/**
 * DQL boolean expression for one pattern against `hayVar` (a DQL field/expression
 * name). Coarse contains()-anchor prefilter: ALL literal anchors in `p.dql` must
 * be present (AND). The exact regex still runs client-side via `re`.
 */
function dqlExprFor(hayVar: string, p: SecurityPattern): string {
  return `(${p.dql.map((lit) => `contains(${hayVar}, ${dqlStringLiteral(lit)})`).join(" and ")})`;
}

/** DQL boolean expression: true when any pattern in the list matches `hayVar`. */
export function dqlMatchesAny(hayVar: string, patterns: SecurityPattern[]): string {
  return `(${patterns.map((p) => dqlExprFor(hayVar, p)).join(" or ")})`;
}

/** Nested if/else DQL expression returning the label of the first matching pattern, else `fallback`. */
export function dqlContextLabelExpr(hayVar: string, patterns: SecurityPattern[], fallback: string): string {
  return patterns.reduceRight(
    (elseExpr, p) => `if(${dqlExprFor(hayVar, p)}, ${dqlStringLiteral(p.label)}, else: ${elseExpr})`,
    dqlStringLiteral(fallback),
  );
}

// ---------------------------------------------------------------------------
// Secrets — vendor API keys, private-key blocks, JWTs, and generic
// password/token assignments, matched against the union of prompt text AND
// tool-call arguments ("any tool input or prompt chunk that matches secret
// patterns").
// ---------------------------------------------------------------------------
export const SECRET_PATTERNS: SecurityPattern[] = [
  // gh: DQL anchors only on the stable "ghp_" prefix (the other stems gho_/
  // ghu_/ghs_/ghr_ can't be captured by a single literal); minor recall loss
  // on the DQL prefilter, exact regex still catches all stems client-side.
  pattern("gh", "GitHub token", ["ghp_"], "gh[pousr]_[a-z0-9]{20,}"),
  pattern("ant", "Anthropic key", ["sk-ant-api03-"], "sk-ant-api03-[a-z0-9_-]{20,}"),
  pattern("oa", "OpenAI key", ["sk-"], "\\bsk-[a-z0-9]{20,}"),
  pattern("aws", "AWS key", ["akia"], "\\bakia[0-9a-z]{16}\\b"),
  pattern("slack", "Slack token", ["xox"], "xox[baprs]-[a-z0-9-]{10,}"),
  pattern("pem", "Private key block", ["-----begin", "private key"], "-----begin [a-z ]*private key-----"),
  pattern("jwt", "JWT bearer token", ["eyj"], "eyj[a-z0-9_-]{10,}\\.[a-z0-9_-]{10,}\\.[a-z0-9_-]{10,}"),
  pattern("kv-password", "Password pasted as text", ["password"], "(password|pwd)\\s*[:=]\\s*\\S{6,}"),
  pattern("kv-token", "API key / token pasted as text", ["token"], "(api[_-]?key|access[_-]?token|secret|token)\\s*[:=]\\s*\\S{10,}"),
];

// ---------------------------------------------------------------------------
// Credential access — a tool touching credential material: SSH/AWS key
// files, .env files, or a curl/wget call carrying Authorization/basic-auth
// credentials. Scoped to tool-call arguments/command text only (referencing
// a filename in prose isn't itself sensitive the way a literal secret is).
// ---------------------------------------------------------------------------
export const CREDENTIAL_PATTERNS: SecurityPattern[] = [
  pattern("ssh-rsa", "SSH private key (id_rsa)", ["id_rsa"], "id_rsa"),
  pattern("ssh-ed25519", "SSH private key (id_ed25519)", ["id_ed25519"], "id_ed25519"),
  pattern("pem-file", "PEM key file", [".pem"], "\\.pem\\b"),
  pattern("ssh-dir", "SSH directory", [".ssh/"], "\\.ssh/"),
  pattern("aws-cred-file", "AWS credentials file", [".aws/credentials"], "\\.aws/credentials"),
  pattern("private-key-arg", "private_key argument", ["private_key"], "private_key"),
  pattern("dotenv", ".env file access", [".env"], "\\.env(\\.[a-z]+)?\\b"),
  pattern("curl-auth-header", "curl Authorization header", ["curl", "authorization"], "curl", "(-h\\s*['\"]?authorization|--header\\s*['\"]?authorization)"),
  pattern("curl-basic-auth", "curl/wget basic-auth credentials", ["curl", "--user"], "(curl|wget)", "(--user\\b|\\s-u\\s|--http-user|--http-password)"),
];

// ---------------------------------------------------------------------------
// Destructive shell commands. Callers additionally gate this on is_terminal
// (Bash / run_in_terminal spans only).
// ---------------------------------------------------------------------------
export const DESTRUCTIVE_PATTERNS: SecurityPattern[] = [
  pattern("rm-rf", "Recursive force delete", ["rm -rf"], "rm -rf"),
  pattern("chmod-777", "World-writable permissions", ["chmod 777"], "chmod 777"),
  pattern("mkfs", "Filesystem format", ["mkfs"], "mkfs"),
  pattern("dd-if", "Raw disk write", ["dd if="], "dd if="),
];

// ---------------------------------------------------------------------------
// Prompt-injection / jailbreak attempts.
// ---------------------------------------------------------------------------
export const JAILBREAK_PATTERNS: SecurityPattern[] = [
  pattern("ignore-instructions", '"Ignore previous instructions"', ["ignore all previous instruction"], "ignore all previous instruction"),
  pattern("reveal-system-prompt", "System-prompt extraction", ["reveal your system prompt"], "reveal your system prompt"),
  pattern("dan", '"Do anything now" jailbreak', ["do anything now"], "do anything now"),
  pattern("bypass", "Guardrail bypass request", ["bypass your"], "bypass your"),
];
