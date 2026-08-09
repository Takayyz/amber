export interface InvitationRequest {
  email: string
}

export interface InvitationResult {
  invitationId: string
}

// Machine-readable rather than prose, because the invite dialog has to tell
// "this address is already a member" apart from "you already invited them" --
// the two need different wording and only one of them is a mistake.
export const INVITATION_ERROR_CODES = [
  'invalid_email',
  'already_member',
  'already_invited',
  'not_pending',
  // Re-sending exists to get a fresh link to someone who is locked out, so
  // a send refused by the provider's hourly cap has to say so rather than
  // read as a generic failure the member would keep retrying.
  'rate_limited',
  'invite_failed',
] as const

export type InvitationErrorCode = (typeof INVITATION_ERROR_CODES)[number]

export interface InvitationErrorResult {
  error: InvitationErrorCode
}

export function isInvitationResult(value: unknown): value is InvitationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).invitationId === 'string'
  )
}

export function isInvitationErrorResult(value: unknown): value is InvitationErrorResult {
  if (typeof value !== 'object' || value === null) return false
  const { error } = value as Record<string, unknown>
  return INVITATION_ERROR_CODES.some((code) => code === error)
}
