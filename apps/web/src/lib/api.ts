import {
  isInvitationErrorResult,
  isInvitationResult,
  isPresignGetResult,
  isPresignPutResult,
  type InvitationErrorCode,
  type PresignPutRequest,
  type PresignPutResult,
} from '@amber/shared'
import { supabase } from '@/lib/supabase'

async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const headers = new Headers(init?.headers)
  if (session) {
    headers.set('Authorization', `Bearer ${session.access_token}`)
  }

  return fetch(`${import.meta.env.VITE_API_URL}${path}`, { ...init, headers })
}

export async function presignPut(params: PresignPutRequest): Promise<PresignPutResult> {
  const response = await authorizedFetch('/uploads/presign-put', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  const data: unknown = await response.json()
  if (!response.ok || !isPresignPutResult(data)) {
    throw new Error('failed to get a presigned upload URL')
  }
  return data
}

export async function presignGet(
  storageKey: string,
  download?: { filename: string },
): Promise<string> {
  const params = new URLSearchParams({ key: storageKey })
  // Sending a filename is what asks for a download; without one the signed
  // URL is just a read, which is what the thumbnails and the viewer want.
  if (download) params.set('filename', download.filename)

  const response = await authorizedFetch(`/media/presign-get?${params.toString()}`)

  const data: unknown = await response.json()
  if (!response.ok || !isPresignGetResult(data)) {
    throw new Error('failed to get a presigned download URL')
  }
  return data.url
}

// Carries the API's error code through to the dialog, which needs to word
// "already a member" differently from a transport failure.
export class InvitationError extends Error {
  readonly code: InvitationErrorCode

  constructor(code: InvitationErrorCode) {
    super(code)
    this.name = 'InvitationError'
    this.code = code
  }
}

async function invitationErrorFrom(response: Response): Promise<InvitationError> {
  const data: unknown = await response.json().catch(() => null)
  return new InvitationError(isInvitationErrorResult(data) ? data.error : 'invite_failed')
}

export async function sendInvitation(email: string): Promise<string> {
  const response = await authorizedFetch('/invitations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })

  if (!response.ok) throw await invitationErrorFrom(response)

  const data: unknown = await response.json()
  if (!isInvitationResult(data)) throw new InvitationError('invite_failed')
  return data.invitationId
}

export async function resendInvitation(invitationId: string): Promise<void> {
  const response = await authorizedFetch(`/invitations/${invitationId}/resend`, { method: 'POST' })
  if (!response.ok) throw await invitationErrorFrom(response)
}

export async function cancelInvitation(invitationId: string): Promise<void> {
  const response = await authorizedFetch(`/invitations/${invitationId}`, { method: 'DELETE' })
  if (!response.ok) throw await invitationErrorFrom(response)
}
