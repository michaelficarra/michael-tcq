#!/usr/bin/env bash
# Regenerate packages/shared/src/devUsers.ts from the current public
# membership of the tc39 GitHub organisation. The seed list backs the
# autocomplete dropdown when GitHub OAuth is disabled in local dev,
# and is also used by scripts/seed-meeting.sh for sample fixtures.
#
# Usage:  scripts/refresh-dev-users.sh
#
# Requires: curl, node (>=18 for built-in fetch is not strictly needed
# since we shell out to curl).

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_file="$repo_root/packages/shared/src/devUsers.ts"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# Reuse a GITHUB_TOKEN if present so we can enrich each member with their
# display name and company without immediately tripping the 60/hr unauth limit.
auth_header=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth_header=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

page=1
while :; do
  curl -sSf "${auth_header[@]}" "https://api.github.com/orgs/tc39/public_members?per_page=100&page=$page" \
    > "$tmp_dir/page_$page.json"
  count="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$tmp_dir/page_$page.json")"
  if [ "$count" = "0" ]; then break; fi
  page=$((page + 1))
done

# Enrich with display name and company via /users/{login}. Skipped when no
# token is configured (the unauth budget is too small for ~150 calls).
mkdir -p "$tmp_dir/users"
if [ ${#auth_header[@]} -gt 0 ]; then
  for f in "$tmp_dir"/page_*.json; do
    for login in $(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).forEach(u=>console.log(u.login))' "$f"); do
      curl -sSf "${auth_header[@]}" "https://api.github.com/users/$login" > "$tmp_dir/users/$login.json" || true
    done
  done
fi

node - "$tmp_dir" "$out_file" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [tmpDir, outFile] = process.argv.slice(2);

const all = fs.readdirSync(tmpDir)
  .filter((f) => f.startsWith('page_') && f.endsWith('.json'))
  .sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(tmpDir, f), 'utf8')));

const usersDir = path.join(tmpDir, 'users');
function enrichmentFor(login) {
  const file = path.join(usersDir, `${login}.json`);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const users = all
  .map((m) => {
    const enr = enrichmentFor(m.login);
    return {
      ghid: m.id,
      login: m.login,
      // Fall back to login when /users returned no display name (or no token
      // was set so enrichment was skipped entirely).
      name: enr?.name || m.login,
      organisation: (enr?.company ?? '').trim(),
      avatarUrl: m.avatar_url,
    };
  })
  .sort((a, b) => a.login.localeCompare(b.login, 'en', { sensitivity: 'base' }));

let out = '';
out += '/**\n';
out += ' * Hardcoded seed list of GitHub users used by the autocomplete feature\n';
out += ' * during local development (when GitHub OAuth is disabled). Generated\n';
out += ' * from the public membership of the tc39 organisation; refresh by\n';
out += ' * re-running scripts/refresh-dev-users.sh.\n';
out += ' */\n\n';
out += 'export interface DevUser {\n';
out += '  ghid: number;\n';
out += '  login: string;\n';
out += '  name: string;\n';
out += '  organisation?: string;\n';
out += '  avatarUrl: string;\n';
out += '}\n\n';
out += 'export const DEV_USERS: readonly DevUser[] = [\n';
for (const u of users) {
  const orgPart = u.organisation ? `, organisation: ${JSON.stringify(u.organisation)}` : '';
  out += `  { ghid: ${u.ghid}, login: ${JSON.stringify(u.login)}, name: ${JSON.stringify(u.name)}${orgPart}, avatarUrl: ${JSON.stringify(u.avatarUrl)} },\n`;
}
out += '] as const;\n';

fs.writeFileSync(outFile, out);
console.log(`Wrote ${users.length} users to ${outFile}`);
NODE
