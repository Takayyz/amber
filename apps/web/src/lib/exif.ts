import { parse as exifrParse, gps as exifrGps } from 'exifr'

export interface ExifData {
  capturedAt: Date | null
  gpsLat: number | null
  gpsLng: number | null
}

function hasDateTimeOriginal(value: unknown): value is { DateTimeOriginal: Date } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'DateTimeOriginal' in value &&
    value.DateTimeOriginal instanceof Date
  )
}

export async function extractExif(file: File): Promise<ExifData> {
  if (!file.type.startsWith('image/')) {
    return { capturedAt: null, gpsLat: null, gpsLng: null }
  }

  const [dateResult, gpsResult] = await Promise.allSettled([
    exifrParse(file, ['DateTimeOriginal']) as Promise<unknown>,
    exifrGps(file),
  ])

  const capturedAt =
    dateResult.status === 'fulfilled' && hasDateTimeOriginal(dateResult.value)
      ? dateResult.value.DateTimeOriginal
      : null

  const gpsLat = gpsResult.status === 'fulfilled' ? gpsResult.value.latitude : null
  const gpsLng = gpsResult.status === 'fulfilled' ? gpsResult.value.longitude : null

  return { capturedAt, gpsLat, gpsLng }
}
