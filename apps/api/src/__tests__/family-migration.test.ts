import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const migrationUrl = new URL(
  '../../../../packages/db/src/migrations/052_family.sql',
  import.meta.url,
)
const bootstrapUrl = new URL(
  '../../../../packages/db/src/migrations/058_family_bootstrap.sql',
  import.meta.url,
)

test('migration 052 defines the invitation-only family boundary', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE family\s*\(/i)
  assert.match(sql, /CREATE TABLE family_member\s*\(/i)
  assert.match(sql, /CREATE TABLE family_invitation\s*\(/i)
  assert.match(sql, /CHECK\s*\(role IN \('admin',\s*'member'\)\)/i)
  assert.match(sql, /CHECK\s*\(status IN \('invited',\s*'active',\s*'disabled'\)\)/i)
  assert.match(sql, /CHECK\s*\(status IN \('pending',\s*'accepted',\s*'revoked',\s*'expired'\)\)/i)
  assert.match(sql, /UNIQUE\s*\(user_id\)/i)
  assert.match(sql, /REFERENCES app_user\(id\)/i)
  assert.match(sql, /same_active_family\s*\(a UUID, b UUID\)/i)
  assert.doesNotMatch(sql, /ALTER\s+(?:TABLE|FUNCTION).*\b0(?:0[1-9]|[1-4][0-9]|5[01])_/i)
})

test('migration 058 bootstraps a family through a granted SECURITY DEFINER routine', async () => {
  const sql = await readFile(bootstrapUrl, 'utf8')

  assert.match(sql, /^-- @supabase-only/m)
  assert.match(sql, /CREATE FUNCTION bootstrap_family\s*\(/i)
  assert.match(sql, /SECURITY DEFINER/i)
  assert.match(sql, /SET search_path = public, pg_temp/i)
  // Owner-not-yet-member is the whole reason this exists: it must write both the
  // family and the admin membership, and hand back the resulting row.
  assert.match(sql, /INSERT INTO family\b/i)
  assert.match(sql, /INSERT INTO family_member\b/i)
  assert.match(sql, /auth\.uid\(\)/i)
  // Least privilege: revoked from PUBLIC, executable only by authenticated.
  assert.match(sql, /REVOKE ALL ON FUNCTION bootstrap_family\(TEXT\) FROM PUBLIC/i)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION bootstrap_family\(TEXT\) TO authenticated/i)
})
