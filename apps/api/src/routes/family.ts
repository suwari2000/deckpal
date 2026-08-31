import { Router } from 'express'

import { cardImages, q, q1, withTx } from '../db.js'
import {
  familyContext,
  requireActiveFamily,
  requireFamilyAdmin,
} from '../family/access.js'
import { ApiError, asyncHandler, clampInt, notFound, UUID_RE, userCache } from '../http.js'
import { currentUserId } from '../identity.js'
import {
  invitationExpiry,
  normalizeInvitationEmail,
  requireSupabaseAdmin,
} from '../family/supabaseAdmin.js'

export const familyRouter: Router = Router()

familyRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    userCache(res)
    const userId = currentUserId(req)
    const context = await familyContext(userId)
    res.json({ userId, family: context })
  }),
)

familyRouter.post(
  '/bootstrap',
  asyncHandler(async (req, res) => {
    const configuredOwner = process.env.FAMILY_OWNER_USER_ID
    if (!configuredOwner) {
      throw new ApiError(503, 'family_owner_unconfigured', 'Family owner is not configured')
    }

    const userId = currentUserId(req)
    if (userId !== configuredOwner) {
      throw new ApiError(403, 'family_owner_required', 'Only the configured family owner can initialise the family')
    }

    const requestedName = typeof req.body?.name === 'string' ? req.body.name.trim() : 'Keluarga Saya'
    const familyName = requestedName.slice(0, 80)
    if (!familyName) throw new ApiError(400, 'bad_request', 'Family name is required')

    // The write goes through the SECURITY DEFINER `bootstrap_family` function
    // (migration 058), not a direct INSERT. Under the request's `authenticated`
    // RLS context the owner cannot yet see the `family` row they are creating,
    // so `INSERT ... RETURNING` and `family_member_bootstrap_insert`'s subquery
    // both come up empty — the function does the privileged write instead.
    type BootstrapRow = {
      out_family_id: string
      out_name: string
      out_role: 'admin' | 'member'
      out_status: 'invited' | 'active' | 'disabled'
    }
    let row: BootstrapRow | null
    try {
      row = await q1<BootstrapRow>(`SELECT * FROM bootstrap_family($1)`, [familyName])
    } catch (err) {
      // Surface the Postgres failure code rather than a bare 500 — the common
      // causes here (missing function, FK to app_user, RLS) each have a
      // distinct SQLSTATE and none of them are sensitive.
      const pg = err as { code?: string; message?: string }
      const detail = pg.code ? `${pg.code}: ${pg.message ?? ''}`.trim() : String(pg.message ?? err)
      throw new ApiError(500, 'family_bootstrap_failed', `Family bootstrap failed — ${detail}`)
    }
    if (!row) throw new ApiError(500, 'family_bootstrap_failed', 'Family bootstrap returned no row')

    res.status(201).json({
      family: {
        familyId: row.out_family_id,
        familyName: row.out_name,
        role: row.out_role,
        status: row.out_status,
      },
    })
  }),
)

familyRouter.post(
  '/invitations',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const admin = await requireFamilyAdmin(userId)
    const email = normalizeInvitationEmail(req.body?.email)
    const duplicate = await q1<{ id: string }>(
      `SELECT id FROM family_invitation
        WHERE family_id = $1 AND lower(email) = $2 AND status = 'pending'`,
      [admin.familyId, email],
    )
    if (duplicate) {
      throw new ApiError(409, 'invitation_pending', 'A pending invitation already exists for this email')
    }

    const redirectTo =
      process.env.FAMILY_INVITE_REDIRECT_URL ??
      `${req.protocol}://${req.get('host') ?? 'localhost'}/auth/invite`
    const supabase = requireSupabaseAdmin()
    const invited = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { family_id: admin.familyId, family_role: 'member' },
    })
    if (invited.error || !invited.data.user?.id) {
      throw new ApiError(502, 'invitation_email_failed', 'The invitation email could not be sent')
    }

    const invitedUserId = invited.data.user.id
    const expiresAt = invitationExpiry()
    const invitation = await withTx(async (client) => {
      const member = await client.query<{ family_id: string }>(
        `INSERT INTO family_member (family_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'invited')
         ON CONFLICT (user_id) DO NOTHING
         RETURNING family_id`,
        [admin.familyId, invitedUserId],
      )
      if (!member.rows[0]) {
        const existing = await client.query<{ family_id: string }>(
          'SELECT family_id FROM family_member WHERE user_id = $1',
          [invitedUserId],
        )
        if (existing.rows[0]?.family_id !== admin.familyId) {
          throw new ApiError(409, 'already_in_family', 'This account already belongs to another family')
        }
      }

      const created = await client.query<{
        id: string
        email: string
        status: string
        expires_at: string
      }>(
        `INSERT INTO family_invitation
           (family_id, invited_user_id, email, role, status, invited_by, expires_at)
         VALUES ($1, $2, $3, 'member', 'pending', $4, $5)
         RETURNING id, email, status, expires_at`,
        [admin.familyId, invitedUserId, email, userId, expiresAt.toISOString()],
      )
      const row = created.rows[0]
      if (!row) throw new Error('invitation insert returned no row')
      return row
    })

    res.status(201).json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expires_at,
      },
    })
  }),
)

familyRouter.get(
  '/invitations',
  asyncHandler(async (req, res) => {
    userCache(res)
    const admin = await requireFamilyAdmin(currentUserId(req))
    const rows = await q<{
      id: string
      email: string
      role: string
      status: string
      expires_at: string
      created_at: string
    }>(
      `SELECT id, email, role, status, expires_at, created_at
         FROM family_invitation
        WHERE family_id = $1
        ORDER BY created_at DESC`,
      [admin.familyId],
    )
    res.json({
      invitations: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      })),
    })
  }),
)

familyRouter.delete(
  '/invitations/:invitationId',
  asyncHandler(async (req, res) => {
    const admin = await requireFamilyAdmin(currentUserId(req))
    const rawId = req.params.invitationId
    const invitationId = Array.isArray(rawId) ? rawId[0] : rawId
    if (!invitationId || !UUID_RE.test(invitationId)) throw notFound('Invitation not found')

    const revoked = await withTx(async (client) => {
      const result = await client.query<{ invited_user_id: string | null }>(
        `UPDATE family_invitation SET status = 'revoked'
          WHERE id = $1 AND family_id = $2 AND status = 'pending'
          RETURNING invited_user_id`,
        [invitationId, admin.familyId],
      )
      const row = result.rows[0]
      if (!row) return null
      if (row.invited_user_id) {
        await client.query(
          `UPDATE family_member SET status = 'disabled'
            WHERE family_id = $1 AND user_id = $2 AND status = 'invited'`,
          [admin.familyId, row.invited_user_id],
        )
      }
      return row
    })
    if (!revoked) throw notFound('Pending invitation not found')
    res.status(204).end()
  }),
)

familyRouter.post(
  '/activate',
  asyncHandler(async (req, res) => {
    const activated = await q1<{
      family_id: string
      role: 'admin' | 'member'
      status: 'active'
    }>('SELECT * FROM activate_family_membership()')
    if (!activated) {
      throw new ApiError(403, 'family_invitation_required', 'No pending family invitation was found')
    }
    const context = await familyContext(currentUserId(req))
    res.json({ family: context })
  }),
)

familyRouter.get(
  '/members',
  asyncHandler(async (req, res) => {
    userCache(res)
    const caller = await requireActiveFamily(currentUserId(req))
    const rows = await q<{
      user_id: string
      username: string
      display_name: string | null
      role: 'admin' | 'member'
      status: 'invited' | 'active' | 'disabled'
      joined_at: string | null
      unique_cards: number | null
      total_quantity: number | null
    }>(
      `SELECT fm.user_id, au.username, up.display_name, fm.role, fm.status,
              fm.joined_at, up.unique_cards, up.total_quantity
         FROM family_member fm
         JOIN app_user au ON au.id = fm.user_id
         LEFT JOIN user_profile up ON up.user_id = fm.user_id
        WHERE fm.family_id = $1
          AND (fm.status = 'active' OR $2 = 'admin')
        ORDER BY CASE fm.role WHEN 'admin' THEN 0 ELSE 1 END,
                 lower(COALESCE(up.display_name, au.username)), fm.user_id`,
      [caller.familyId, caller.role],
    )
    res.json({
      members: rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        joinedAt: row.joined_at,
        uniqueCards: row.unique_cards ?? 0,
        totalQuantity: row.total_quantity ?? 0,
      })),
    })
  }),
)

interface CollectionCursor {
  updatedAt: string
  id: string
}

function decodeCursor(value: unknown): CollectionCursor | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CollectionCursor
    if (!parsed.updatedAt || !parsed.id) return null
    return parsed
  } catch {
    return null
  }
}

function encodeCursor(cursor: CollectionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

familyRouter.get(
  '/members/:userId/collection',
  asyncHandler(async (req, res) => {
    userCache(res)
    const caller = await requireActiveFamily(currentUserId(req))
    const rawUserId = req.params.userId
    const targetUserId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId
    if (!targetUserId || !UUID_RE.test(targetUserId)) throw notFound('Family member not found')

    const target = await q1<{ user_id: string }>(
      `SELECT user_id FROM family_member
        WHERE family_id = $1 AND user_id = $2 AND status = 'active'`,
      [caller.familyId, targetUserId],
    )
    if (!target) throw notFound('Family member not found')

    const limit = clampInt(req.query.limit, 40, 1, 100)
    const cursor = decodeCursor(req.query.cursor)
    const rows = await q<{
      id: string
      card_variant_id: string
      quantity: number
      condition: string | null
      updated_at: string
      card_id: string
      card_tcgdex_id: string
      card_name: string
      local_id: string
      variant_name: string | null
      set_name: string
      set_tcgdex_id: string
      series_tcgdex_id: string
    }>(
      `SELECT ci.id, ci.card_variant_id, ci.quantity, ci.condition, ci.updated_at,
              c.id AS card_id, c.tcgdex_id AS card_tcgdex_id, c.name AS card_name,
              c.local_id, cv.display_name AS variant_name, cs.name AS set_name,
              cs.tcgdex_id AS set_tcgdex_id, s.tcgdex_id AS series_tcgdex_id
         FROM collection_item ci
         JOIN card_variant cv ON cv.id = ci.card_variant_id
         JOIN card c ON c.id = cv.card_id
         JOIN card_set cs ON cs.id = c.set_id
         JOIN series s ON s.id = cs.series_id
        WHERE ci.user_id = $1 AND ci.quantity > 0
          AND ($2::timestamptz IS NULL OR (ci.updated_at, ci.id) < ($2::timestamptz, $3::bigint))
        ORDER BY ci.updated_at DESC, ci.id DESC
        LIMIT $4`,
      [targetUserId, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
    )

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    res.json({
      ownerUserId: targetUserId,
      items: page.map((row) => ({
        id: row.id,
        cardVariantId: row.card_variant_id,
        cardId: row.card_id,
        cardTcgdexId: row.card_tcgdex_id,
        cardName: row.card_name,
        number: row.local_id,
        variantName: row.variant_name,
        setName: row.set_name,
        quantity: row.quantity,
        condition: row.condition,
        updatedAt: row.updated_at,
        images: cardImages(row.series_tcgdex_id, row.set_tcgdex_id, row.local_id),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ updatedAt: last.updated_at, id: last.id })
          : null,
    })
  }),
)

familyRouter.patch(
  '/members/:userId',
  asyncHandler(async (req, res) => {
    const admin = await requireFamilyAdmin(currentUserId(req))
    const rawUserId = req.params.userId
    const targetUserId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId
    if (!targetUserId || !UUID_RE.test(targetUserId)) throw notFound('Family member not found')
    if (targetUserId === currentUserId(req)) {
      throw new ApiError(400, 'admin_self_disable', 'The active administrator cannot disable their own account')
    }
    const status = req.body?.status
    if (status !== 'active' && status !== 'disabled') {
      throw new ApiError(400, 'bad_request', 'status must be active or disabled')
    }
    const changed = await q1<{ user_id: string; status: string }>(
      `UPDATE family_member SET status = $3, joined_at = CASE WHEN $3 = 'active' THEN COALESCE(joined_at, now()) ELSE joined_at END
        WHERE family_id = $1 AND user_id = $2
        RETURNING user_id, status`,
      [admin.familyId, targetUserId, status],
    )
    if (!changed) throw notFound('Family member not found')
    res.json({ member: { userId: changed.user_id, status: changed.status } })
  }),
)
