// How a member is named on screen, in one place: the photo detail footer and
// the profile dialog have to agree on what an empty name means.

// uploaded_by is `on delete set null`, so a photo outlives the member who added
// it. That is a different state from "here but unnamed" and reads differently.
const REMOVED_MEMBER = '削除されたメンバー'
const UNNAMED_MEMBER = '名前未設定'

/** The row shape both callers share: the FK, plus the joined member if any. */
export interface UploaderSource {
  uploaded_by: string | null
  uploader: { display_name: string | null } | null
}

/**
 * `display_name` is a plain nullable text column with nothing stopping a member
 * from saving spaces, so whitespace counts as unset here as well as on save.
 */
export function displayNameOrNull(name: string | null | undefined): string | null {
  const trimmed = name?.trim()
  return trimmed ? trimmed : null
}

export function uploaderLabel(item: UploaderSource): string {
  if (!item.uploaded_by) return REMOVED_MEMBER
  return displayNameOrNull(item.uploader?.display_name) ?? UNNAMED_MEMBER
}

/** The header falls back to the address, which is the only other handle a member has. */
export function selfLabel(displayName: string | null, email: string | undefined): string {
  return displayNameOrNull(displayName) ?? email ?? UNNAMED_MEMBER
}
