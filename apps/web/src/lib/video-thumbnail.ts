// The short edge rather than the long one: the grid draws square cells with
// object-cover, which scales the short edge to fill and crops the rest, so
// the short edge is what decides how sharp the cell looks.
const SHORT_EDGE_PX = 512
const JPEG_QUALITY = 0.75
// Frame zero is often black -- a fade-in starts there, and so does the first
// keyframe of a clip that begins in darkness. Half the duration keeps a video
// shorter than a fifth of a second in range.
const SEEK_SECONDS = 0.1
// A codec the browser cannot decode usually fires `error`, but not reliably.
// Without a deadline a stuck decode would hold the whole upload open.
const TIMEOUT_MS = 10_000

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: number | undefined

  const deadline = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('video decode timed out')), TIMEOUT_MS)
  })

  return Promise.race([work, deadline]).finally(() => window.clearTimeout(timer))
}

/**
 * Resolves when `event` fires, rejects if the element errors first. The
 * trigger runs after both listeners are attached, so an error raised
 * synchronously by assigning `src` is still caught.
 */
function once(video: HTMLVideoElement, event: string, trigger: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(event, onDone)
      video.removeEventListener('error', onError)
    }
    const onDone = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`video failed before ${event}`))
    }

    video.addEventListener(event, onDone)
    video.addEventListener('error', onError)
    trigger()
  })
}

/**
 * A JPEG of the video's opening frame, or null if this browser cannot get one.
 *
 * Best-effort by design (README "Video previews"): an iPhone's HEVC .MOV
 * decodes in Safari and generally not in desktop Chrome, and the upload has to
 * succeed either way. Every failure path returns null rather than throwing.
 */
export async function extractVideoThumbnail(file: File): Promise<Blob | null> {
  const objectUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'

  try {
    await withTimeout(
      once(video, 'loadedmetadata', () => {
        video.src = objectUrl
      }),
    )

    await withTimeout(
      once(video, 'seeked', () => {
        video.currentTime = Math.min(SEEK_SECONDS, video.duration / 2)
      }),
    )

    const { videoWidth, videoHeight } = video
    if (!videoWidth || !videoHeight) return null

    // Never upscale: a video already smaller than the target keeps its size
    // rather than being blown up into a blurrier file.
    const scale = Math.min(SHORT_EDGE_PX / Math.min(videoWidth, videoHeight), 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(videoWidth * scale)
    canvas.height = Math.round(videoHeight * scale)

    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    })
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(objectUrl)
    // Drops the decoder now rather than leaving it to collection, which
    // matters when several files are uploading at once.
    video.removeAttribute('src')
    video.load()
  }
}
