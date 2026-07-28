import {
  isPresignGetResult,
  isPresignPutResult,
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

export async function presignGet(storageKey: string): Promise<string> {
  const response = await authorizedFetch(`/media/presign-get?key=${encodeURIComponent(storageKey)}`)

  const data: unknown = await response.json()
  if (!response.ok || !isPresignGetResult(data)) {
    throw new Error('failed to get a presigned download URL')
  }
  return data.url
}
