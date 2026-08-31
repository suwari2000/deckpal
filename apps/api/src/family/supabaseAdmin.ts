import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { ApiError } from '../http.js'

let cached: SupabaseClient | null | undefined
let warned = false

export function supabaseAdminStatus(): 'configured' | 'unset' {
  return process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? 'configured'
    : 'unset'
}

export function getSupabaseAdmin(): SupabaseClient | null {
  if (cached !== undefined) return cached
  const url = process.env.VITE_SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRole) {
    if (!warned) {
      warned = true
      console.warn('[deckpal-family] Supabase admin invitation service is not configured')
    }
    cached = null
    return null
  }
  cached = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return cached
}

export function requireSupabaseAdmin(): SupabaseClient {
  const client = getSupabaseAdmin()
  if (!client) {
    throw new ApiError(503, 'family_invites_unconfigured', 'Family invitation email is not configured')
  }
  return client
}

export function normalizeInvitationEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new ApiError(400, 'invalid_email', 'Enter a valid email address')
  }
  return email
}

export function invitationExpiry(now = new Date()): Date {
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
}

/**
 * Mint a one-time link that lets `email` claim its account, WITHOUT sending an
 * email. `generateLink` creates the auth user the same way `inviteUserByEmail`
 * does — the difference is only who delivers the link, and here that is the
 * admin, by hand.
 *
 * `type` is the one thing callers vary: `invite` for an address the project has
 * never seen, `magiclink` to re-issue for an account that already exists (a
 * fresh `invite` for a known address is refused by GoTrue).
 *
 * The returned link is a CREDENTIAL — whoever holds it becomes that account.
 * It is handed to the admin who asked for it and is never logged or stored.
 */
export async function generateInviteLink(
  client: SupabaseClient,
  params: { type: 'invite' | 'magiclink'; email: string; redirectTo: string; familyId: string },
): Promise<{ link: string; userId: string }> {
  let result: Awaited<ReturnType<typeof client.auth.admin.generateLink>>
  try {
    result = await client.auth.admin.generateLink({
      type: params.type,
      email: params.email,
      options: {
        redirectTo: params.redirectTo,
        data: { family_id: params.familyId, family_role: 'member' },
      },
    })
  } catch (err) {
    // supabase-js returns AuthApiError in `error` and re-throws anything else,
    // so a throw here is the transport, not the provider refusing.
    const detail = err instanceof Error ? err.message : String(err)
    throw new ApiError(502, 'invite_link_failed', `Supabase auth unreachable — ${detail}`)
  }

  const link = result.data?.properties?.action_link
  const userId = result.data?.user?.id
  if (result.error || !link || !userId) {
    const detail = result.error?.message ?? 'no action link was returned'
    throw new ApiError(502, 'invite_link_failed', `The invitation link could not be created — ${detail}`)
  }
  return { link, userId }
}

export function resetSupabaseAdminForTests(): void {
  cached = undefined
  warned = false
}
