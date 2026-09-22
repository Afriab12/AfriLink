// Vocabulary approved for the Communities module. membership_policy and
// memberships.role are validated text in the schema (database.md §8 never
// enumerated them), so the closed sets live here, in one place.
export const COMMUNITY_VISIBILITIES = ['public', 'private'] as const;
export const MEMBERSHIP_POLICIES = ['open', 'approval_required', 'invite_only'] as const;

// The owner is implicit (communities.owner_user_id) and never has a
// membership row, so 'owner' is not a value a row can carry.
export const MEMBER_ROLES = ['member', 'moderator'] as const;

// Lower-case ASCII words joined by single hyphens, and never shaped like a
// UUID (GET /communities/{idOrSlug} tells the two apart by shape).
export const SLUG_PATTERN = /^(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
