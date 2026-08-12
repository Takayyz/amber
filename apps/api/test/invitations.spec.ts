import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AUTH_ADMIN_USERS_PATH,
  AUTH_INVITE_PATH,
  INVITATION_ID,
  INVITED_USER_ID,
  INVITEE_EMAIL,
  MEMBER_ID,
  authedRequest,
  bodyWith,
  endOfTest,
  errorCode,
  invitationQuery,
  invitationRow,
  justSentAt,
  mockNetwork,
  pathIs,
  supabase,
} from './helpers'

// The account a re-send creates. It differs from INVITED_USER_ID because the
// original one can be gone by then, and writing the new id back is the only
// thing that keeps the invitation revocable.
const REINVITED_USER_ID = '44444444-4444-4444-8444-444444444444'

const PENDING_FOR_EMAIL = { email: `eq.${INVITEE_EMAIL}`, status: 'eq.pending' }
const BY_ID = { id: `eq.${INVITATION_ID}` }

function invite(email = INVITEE_EMAIL) {
  return authedRequest('/invitations', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

function resend(id = INVITATION_ID) {
  return authedRequest(`/invitations/${id}/resend`, { method: 'POST' })
}

function cancel(id = INVITATION_ID) {
  return authedRequest(`/invitations/${id}`, { method: 'DELETE' })
}

describe('invitations', () => {
  beforeAll(mockNetwork)

  // Nothing may be left over: an unused interceptor is a call the worker was
  // supposed to make and did not.
  afterEach(endOfTest)

  describe('POST /invitations', () => {
    it('rejects a malformed address without touching Supabase', async () => {
      const response = await invite('not-an-address')

      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('invalid_email')
    })

    // Reading a failed lookup as "no invitation yet" is what would send a
    // second invite for an address that already has one -- and, further down
    // the cancel path, delete somebody else's account.
    it('stops when the pending lookup fails rather than assuming there is none', async () => {
      supabase()
        .intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) })
        .reply(500, { message: 'boom' })

      const response = await invite()

      // No interceptor for /auth/v1/invite: reaching it would throw against the
      // blocked network and surface as a 500 instead.
      expect(response.status).toBe(502)
      expect(await errorCode(response)).toBe('invite_failed')
    })

    it('refuses an address that already has a pending invitation', async () => {
      supabase()
        .intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) })
        .reply(200, [invitationRow()])

      const response = await invite()

      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('already_invited')
    })

    it('invites the address and records who sent it', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) }).reply(200, [])
      supabase()
        .intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH), body: bodyWith({ email: INVITEE_EMAIL }) })
        .reply(200, { id: INVITED_USER_ID })
      supabase()
        .intercept({
          method: 'POST',
          path: invitationQuery({}),
          body: bodyWith({ email: INVITEE_EMAIL, invited_by: MEMBER_ID, invited_user_id: INVITED_USER_ID }),
        })
        .reply(201, [invitationRow()])

      const response = await invite()

      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({ invitationId: INVITATION_ID })
    })

    it('lowercases the address before looking it up', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) }).reply(200, [])
      supabase()
        .intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH), body: bodyWith({ email: INVITEE_EMAIL }) })
        .reply(200, { id: INVITED_USER_ID })
      supabase().intercept({ method: 'POST', path: invitationQuery({}) }).reply(201, [invitationRow()])

      const response = await invite(`  ${INVITEE_EMAIL.toUpperCase()}  `)

      expect(response.status).toBe(201)
    })

    // Supabase Auth refuses to invite a confirmed account, which is the only
    // "already a member" check available -- there is no email on public.members.
    it('reports an existing member as a conflict', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) }).reply(200, [])
      supabase()
        .intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH) })
        .reply(422, { error_code: 'email_exists' })

      const response = await invite()

      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('already_member')
    })

    it('passes the provider send cap through as a rate limit', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) }).reply(200, [])
      supabase()
        .intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH) })
        .reply(429, { error_code: 'over_email_send_rate_limit' })

      const response = await invite()

      expect(response.status).toBe(429)
      expect(await errorCode(response)).toBe('rate_limited')
    })

    // Auth hands back the *existing* unconfirmed user rather than making a new
    // one, so the account belongs to whichever invitation won the race. Deleting
    // it here would destroy theirs.
    it('leaves the account alone when another invitation won the race', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) }).reply(200, [])
      supabase().intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH) }).reply(200, { id: INVITED_USER_ID })
      supabase().intercept({ method: 'POST', path: invitationQuery({}) }).reply(409, { code: '23505' })

      const response = await invite()

      // A delete would hit the blocked network and come back 500.
      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('already_invited')
    })

    // PostgREST answers 409 for a foreign-key violation as well, so the status
    // alone would report "already invited" for a sender whose own members row
    // is missing. This one really is ours, so it gets cleaned up.
    it('revokes the account when the ledger write fails for another reason', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(PENDING_FOR_EMAIL) }).reply(200, [])
      supabase().intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH) }).reply(200, { id: INVITED_USER_ID })
      supabase().intercept({ method: 'POST', path: invitationQuery({}) }).reply(409, { code: '23503' })
      supabase().intercept({ method: 'DELETE', path: `${AUTH_ADMIN_USERS_PATH}/${INVITED_USER_ID}` }).reply(200, {})

      const response = await invite()

      expect(response.status).toBe(502)
      expect(await errorCode(response)).toBe('invite_failed')
    })
  })

  describe('POST /invitations/:id/resend', () => {
    it('reports a missing invitation as not pending', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(BY_ID) }).reply(200, [])

      const response = await resend()

      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('not_pending')
    })

    it('refuses to re-send one that already left pending', async () => {
      supabase()
        .intercept({ method: 'GET', path: invitationQuery(BY_ID) })
        .reply(200, [invitationRow({ status: 'accepted' })])

      const response = await resend()

      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('not_pending')
    })

    // Our own cooldown, checked before the provider's: its cap is a service-wide
    // hourly budget shared with magic-link login, and spending it on re-sends
    // would lock existing members out of signing in.
    it('refuses a second send within the cooldown', async () => {
      supabase()
        .intercept({ method: 'GET', path: invitationQuery(BY_ID) })
        .reply(200, [invitationRow({ last_sent_at: justSentAt() })])

      const response = await resend()

      expect(response.status).toBe(429)
      expect(await errorCode(response)).toBe('resend_too_soon')
    })

    // invited_user_id is `on delete set null`, so it empties when the account
    // goes away under a still-pending row. The re-invite made a fresh account,
    // and writing its id back is what keeps cancel able to revoke it.
    it('writes the new account id back alongside the cooldown stamp', async () => {
      supabase()
        .intercept({ method: 'GET', path: invitationQuery(BY_ID) })
        .reply(200, [invitationRow({ invited_user_id: null })])
      supabase().intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH) }).reply(200, { id: REINVITED_USER_ID })
      supabase()
        .intercept({
          method: 'PATCH',
          path: invitationQuery({ ...BY_ID, status: 'eq.pending' }),
          body: bodyWith({ invited_user_id: REINVITED_USER_ID }),
        })
        .reply(200, [invitationRow({ invited_user_id: REINVITED_USER_ID })])

      const response = await resend()

      expect(response.status).toBe(204)
    })

    // Cancelled while the mail was going out. The account the re-invite just
    // created belongs to nothing now, and a cancelled row is not listed
    // anywhere, so leaving it would hide an address that can still log in.
    it('takes the new account back out when the row was cancelled mid-send', async () => {
      supabase().intercept({ method: 'GET', path: invitationQuery(BY_ID) }).reply(200, [invitationRow()])
      supabase().intercept({ method: 'POST', path: pathIs(AUTH_INVITE_PATH) }).reply(200, { id: REINVITED_USER_ID })
      supabase()
        .intercept({ method: 'PATCH', path: invitationQuery({ ...BY_ID, status: 'eq.pending' }) })
        .reply(200, [])
      supabase().intercept({ method: 'DELETE', path: `${AUTH_ADMIN_USERS_PATH}/${REINVITED_USER_ID}` }).reply(200, {})

      const response = await resend()

      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('not_pending')
    })
  })

  describe('DELETE /invitations/:id', () => {
    const CLAIM = { ...BY_ID, status: 'eq.pending' }
    const UNDO_CLAIM = { ...BY_ID, status: 'eq.cancelled' }

    // Reporting a failed write as "already cancelled" would tell the member the
    // job is done when nothing has happened yet.
    it('does not claim success when the status flip fails', async () => {
      supabase().intercept({ method: 'PATCH', path: invitationQuery(CLAIM) }).reply(500, { message: 'boom' })

      const response = await cancel()

      expect(response.status).toBe(502)
      expect(await errorCode(response)).toBe('invite_failed')
    })

    it('reports a row that had already left pending', async () => {
      supabase().intercept({ method: 'PATCH', path: invitationQuery(CLAIM) }).reply(200, [])

      const response = await cancel()

      expect(response.status).toBe(409)
      expect(await errorCode(response)).toBe('not_pending')
    })

    // Claiming the row first is what earns the right to delete: checking and
    // deleting afterwards would let a confirmation land in between and destroy
    // an account that had just legitimately become a member.
    it('claims the row, then revokes the account', async () => {
      supabase().intercept({ method: 'PATCH', path: invitationQuery(CLAIM) }).reply(200, [invitationRow()])
      supabase().intercept({ method: 'DELETE', path: `${AUTH_ADMIN_USERS_PATH}/${INVITED_USER_ID}` }).reply(200, {})

      const response = await cancel()

      expect(response.status).toBe(204)
    })

    // A missing pointer means it was lost, not that there is nothing to revoke.
    it('falls back to the address when the account pointer was emptied', async () => {
      supabase()
        .intercept({ method: 'PATCH', path: invitationQuery(CLAIM) })
        .reply(200, [invitationRow({ invited_user_id: null })])
      supabase()
        .intercept({ method: 'GET', path: pathIs(AUTH_ADMIN_USERS_PATH) })
        .reply(200, { users: [{ id: REINVITED_USER_ID, email: INVITEE_EMAIL }] })
      supabase().intercept({ method: 'DELETE', path: `${AUTH_ADMIN_USERS_PATH}/${REINVITED_USER_ID}` }).reply(200, {})

      const response = await cancel()

      expect(response.status).toBe(204)
    })

    // `filter` is a substring search, so a near-miss must not be mistaken for
    // the invitee's own account.
    it('ignores an address that merely contains the invitee', async () => {
      supabase()
        .intercept({ method: 'PATCH', path: invitationQuery(CLAIM) })
        .reply(200, [invitationRow({ invited_user_id: null })])
      supabase()
        .intercept({ method: 'GET', path: pathIs(AUTH_ADMIN_USERS_PATH) })
        .reply(200, { users: [{ id: REINVITED_USER_ID, email: `not-${INVITEE_EMAIL}` }] })

      const response = await cancel()

      // Nothing to revoke, so no delete goes out -- one would hit the blocked
      // network and come back 500.
      expect(response.status).toBe(204)
    })

    // Answering 204 on a failed lookup would report the access revoked while it
    // still works, and a cancelled row is not listed anywhere to try again from.
    it('puts the row back when the address lookup fails', async () => {
      supabase()
        .intercept({ method: 'PATCH', path: invitationQuery(CLAIM) })
        .reply(200, [invitationRow({ invited_user_id: null })])
      supabase().intercept({ method: 'GET', path: pathIs(AUTH_ADMIN_USERS_PATH) }).reply(500, { message: 'boom' })
      supabase().intercept({ method: 'PATCH', path: invitationQuery(UNDO_CLAIM) }).reply(200, [invitationRow()])

      const response = await cancel()

      expect(response.status).toBe(502)
      expect(await errorCode(response)).toBe('invite_failed')
    })

    it('puts the row back when the account will not delete', async () => {
      supabase().intercept({ method: 'PATCH', path: invitationQuery(CLAIM) }).reply(200, [invitationRow()])
      supabase()
        .intercept({ method: 'DELETE', path: `${AUTH_ADMIN_USERS_PATH}/${INVITED_USER_ID}` })
        .reply(500, { message: 'boom' })
      supabase().intercept({ method: 'PATCH', path: invitationQuery(UNDO_CLAIM) }).reply(200, [invitationRow()])

      const response = await cancel()

      expect(response.status).toBe(502)
    })

    // An account that is already gone is the state the cancel wanted anyway.
    it('treats an already-deleted account as revoked', async () => {
      supabase().intercept({ method: 'PATCH', path: invitationQuery(CLAIM) }).reply(200, [invitationRow()])
      supabase().intercept({ method: 'DELETE', path: `${AUTH_ADMIN_USERS_PATH}/${INVITED_USER_ID}` }).reply(404, {})

      const response = await cancel()

      expect(response.status).toBe(204)
    })
  })
})
