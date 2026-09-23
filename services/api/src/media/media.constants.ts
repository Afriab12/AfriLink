// Vocabulary and limits approved for the Media module (docs/05-api/media.md,
// owner decisions 2026-09-22). Every number here was explicitly proposed and
// approved — none is a placeholder guess.

export const ASSET_KINDS = ['image', 'video'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

// Starter purpose vocabulary (media.md §3) — validated text at the database
// layer (extensible without a migration), but the API only accepts this
// approved set today.
export const ASSET_PURPOSES = ['avatar', 'cover', 'post', 'message_attachment'] as const;
export type AssetPurpose = (typeof ASSET_PURPOSES)[number];

// Which purposes accept which kind (media.md §3's purpose/kind table).
// message_attachment is image-only per PRD §19/architecture.md §14.
export const PURPOSE_ALLOWED_KINDS: Record<AssetPurpose, readonly AssetKind[]> = {
  avatar: ['image'],
  cover: ['image'],
  post: ['image', 'video'],
  message_attachment: ['image'],
};

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const ALL_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const;

export const MIME_TYPES_BY_KIND: Record<AssetKind, readonly string[]> = {
  image: IMAGE_MIME_TYPES,
  video: VIDEO_MIME_TYPES,
};

// Owner-approved 2026-09-22 (docs/05-api/media.md §12, resolved).
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_VIDEO_DURATION_SECONDS = 120;

export const MAX_BYTES_BY_KIND: Record<AssetKind, number> = {
  image: MAX_IMAGE_BYTES,
  video: MAX_VIDEO_BYTES,
};

// Signed upload URL lifetime (media.md §12, resolved).
export const UPLOAD_URL_EXPIRY_SECONDS = 60 * 60; // 60 minutes

// Pending Upload/Asset reservation lifetime — Upload.expiresAt (media.md §12,
// resolved). Longer than the URL expiry on purpose: this is application-level
// bookkeeping for when WE consider the attempt abandoned, not the storage
// provider's own signed-request expiry.
export const UPLOAD_RESERVATION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Signed GET URL lifetime for GET /media/{id}'s variant URLs — generated
// fresh per request, never stored (media.md §1.3, §11). No variant exists
// yet without a processing worker, but the constant is defined now so the
// value lives in one place when that phase adds it.
export const READ_URL_EXPIRY_SECONDS = 5 * 60; // 5 minutes
