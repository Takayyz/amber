import { useCallback, useEffect, useRef, useState } from 'react'
import { UploadError, uploadMediaItem, type StoredObject } from '@/lib/upload'

export type UploadStatus = 'queued' | 'sending' | 'done' | 'failed'

export interface UploadTask {
  id: string
  fileName: string
  totalBytes: number
  sentBytes: number
  status: UploadStatus
  errorMessage: string | undefined
}

export interface UploadQueue {
  tasks: UploadTask[]
  sentBytes: number
  totalBytes: number
  doneCount: number
  failedCount: number
  active: boolean
  enqueue: (files: FileList | File[]) => void
  retryFailed: () => void
  cancelAll: () => void
  dismiss: () => void
}

// Enough to keep the connection busy without the transfers starving each other.
// A phone on mobile data is the case this is sized for, not a desktop on fibre.
const MAX_CONCURRENT_UPLOADS = 3

// Two attempts past the first, backing off 1s then 2s. Beyond that it is not a
// blip, and a failure the member can act on beats a spinner that keeps trying.
const MAX_AUTO_RETRIES = 2
const RETRY_BASE_DELAY_MS = 1000

const CANCELLED_MESSAGE = '中止しました'

interface QueueEntry {
  file: File
  attempt: number
  // Carried between attempts so a retry after a successful PUT records the
  // object already in R2 instead of uploading a second copy.
  stored: StoredObject | undefined
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish)
  })
}

function messageFor(error: unknown): string {
  return error instanceof UploadError ? error.message : 'アップロードに失敗しました'
}

/**
 * Runs uploads a few at a time, retries the failures worth retrying, and
 * exposes a snapshot for the tray to render.
 *
 * The live state sits in refs rather than React state: the workers run outside
 * the render cycle and would otherwise read stale closures. React sees only a
 * snapshot, published at most once a frame — a 500 MB PUT fires hundreds of
 * progress events, and setting state on each would spend the frame budget
 * re-rendering instead of uploading.
 */
export function useUploadQueue(
  albumId: string | undefined,
  userId: string | undefined,
  onSettled: () => void,
): UploadQueue {
  const [tasks, setTasks] = useState<UploadTask[]>([])

  const tasksRef = useRef<Map<string, UploadTask>>(new Map())
  const entriesRef = useRef<Map<string, QueueEntry>>(new Map())
  const pendingRef = useRef<string[]>([])
  const runningRef = useRef(0)
  const abortRef = useRef<AbortController>(new AbortController())
  const publishFrameRef = useRef<number | null>(null)
  const nextIdRef = useRef(0)

  // Read at call time so the effect below never has to re-subscribe, and the
  // workers never call a stale version of it.
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  const publish = useCallback((immediate = false) => {
    if (publishFrameRef.current !== null) {
      if (!immediate) return
      cancelAnimationFrame(publishFrameRef.current)
    }

    const flush = () => {
      publishFrameRef.current = null
      setTasks([...tasksRef.current.values()])
    }

    if (immediate) {
      flush()
      return
    }
    publishFrameRef.current = requestAnimationFrame(flush)
  }, [])

  const update = useCallback((id: string, changes: Partial<UploadTask>) => {
    const task = tasksRef.current.get(id)
    if (task) tasksRef.current.set(id, { ...task, ...changes })
  }, [])

  // Self-recursive: a finished upload starts the next one. Held in a ref so the
  // callback does not have to list itself as its own dependency.
  const pumpRef = useRef<() => void>(() => {})

  const pump = useCallback(() => {
    if (!albumId || !userId) return

    while (runningRef.current < MAX_CONCURRENT_UPLOADS && pendingRef.current.length > 0) {
      const id = pendingRef.current.shift()
      if (id === undefined) break
      const entry = entriesRef.current.get(id)
      if (!entry) continue

      runningRef.current += 1
      update(id, { status: 'sending', errorMessage: undefined })
      publish(true)

      const { signal } = abortRef.current

      uploadMediaItem(entry.file, albumId, userId, {
        signal,
        stored: entry.stored,
        onProgress: (sentBytes) => {
          update(id, { sentBytes })
          publish()
        },
      })
        .then(() => update(id, { status: 'done', sentBytes: entry.file.size }))
        .catch(async (error: unknown) => {
          if (signal.aborted) {
            update(id, { status: 'failed', errorMessage: CANCELLED_MESSAGE })
            return
          }

          const stored = error instanceof UploadError ? error.stored : undefined
          const retryable = error instanceof UploadError && error.retryable

          if (retryable && entry.attempt < MAX_AUTO_RETRIES) {
            await delay(RETRY_BASE_DELAY_MS * 2 ** entry.attempt, signal)
            if (signal.aborted) {
              update(id, { status: 'failed', errorMessage: CANCELLED_MESSAGE })
              return
            }
            entriesRef.current.set(id, { ...entry, attempt: entry.attempt + 1, stored })
            pendingRef.current.push(id)
            update(id, { status: 'queued', sentBytes: 0 })
            return
          }

          // Even when giving up, keep what reached R2: the member's retry then
          // only has the ledger row left to write.
          entriesRef.current.set(id, { ...entry, stored })
          update(id, { status: 'failed', errorMessage: messageFor(error) })
        })
        .finally(() => {
          runningRef.current -= 1
          publish(true)

          if (runningRef.current === 0 && pendingRef.current.length === 0) {
            // One refresh once everything comes to rest, rather than one per
            // file. A cancelled run refreshes too — whatever landed before the
            // stop belongs on screen.
            onSettledRef.current()
            return
          }
          pumpRef.current()
        })
    }
  }, [albumId, userId, publish, update])

  pumpRef.current = pump

  const restartIfStopped = useCallback(() => {
    // An aborted controller stays aborted, so a new batch needs its own or
    // every upload in it would abort on arrival.
    if (abortRef.current.signal.aborted) abortRef.current = new AbortController()
  }, [])

  const enqueue = useCallback(
    (files: FileList | File[]) => {
      const chosen = Array.from(files)
      if (chosen.length === 0) return
      restartIfStopped()

      for (const file of chosen) {
        const id = `upload-${nextIdRef.current++}`
        tasksRef.current.set(id, {
          id,
          fileName: file.name,
          totalBytes: file.size,
          sentBytes: 0,
          status: 'queued',
          errorMessage: undefined,
        })
        entriesRef.current.set(id, { file, attempt: 0, stored: undefined })
        pendingRef.current.push(id)
      }

      publish(true)
      pump()
    },
    [publish, pump, restartIfStopped],
  )

  const retryFailed = useCallback(() => {
    restartIfStopped()

    let requeued = false
    for (const task of tasksRef.current.values()) {
      if (task.status !== 'failed') continue
      const entry = entriesRef.current.get(task.id)
      if (!entry) continue

      // The attempt counter resets: this is the member asking again, not the
      // automatic backoff carrying on.
      entriesRef.current.set(task.id, { ...entry, attempt: 0 })
      pendingRef.current.push(task.id)
      tasksRef.current.set(task.id, {
        ...task,
        status: 'queued',
        sentBytes: 0,
        errorMessage: undefined,
      })
      requeued = true
    }

    if (!requeued) return
    publish(true)
    pump()
  }, [publish, pump, restartIfStopped])

  const cancelAll = useCallback(() => {
    abortRef.current.abort()
    pendingRef.current = []

    // Settled here rather than left to each request's abort event. A queued
    // file has no request to abort at all, and an aborted XHR only reports back
    // if it had already been sent -- either way the member pressed stop and the
    // tray has to say so now, not once the transport gets round to it.
    for (const task of tasksRef.current.values()) {
      if (task.status === 'queued' || task.status === 'sending') {
        tasksRef.current.set(task.id, { ...task, status: 'failed', errorMessage: CANCELLED_MESSAGE })
      }
    }
    publish(true)
  }, [publish])

  const dismiss = useCallback(() => {
    tasksRef.current.clear()
    entriesRef.current.clear()
    publish(true)
  }, [publish])

  // Uploading belongs to this screen, so leaving it stops the transfers rather
  // than letting them report into a component that is gone.
  useEffect(() => {
    const controller = abortRef.current
    return () => {
      controller.abort()
      if (publishFrameRef.current !== null) cancelAnimationFrame(publishFrameRef.current)
    }
  }, [])

  const totals = tasks.reduce(
    (sum, task) => ({
      sentBytes: sum.sentBytes + task.sentBytes,
      totalBytes: sum.totalBytes + task.totalBytes,
      doneCount: sum.doneCount + (task.status === 'done' ? 1 : 0),
      failedCount: sum.failedCount + (task.status === 'failed' ? 1 : 0),
    }),
    { sentBytes: 0, totalBytes: 0, doneCount: 0, failedCount: 0 },
  )

  const active = tasks.some((task) => task.status === 'queued' || task.status === 'sending')

  return { tasks, active, ...totals, enqueue, retryFailed, cancelAll, dismiss }
}
