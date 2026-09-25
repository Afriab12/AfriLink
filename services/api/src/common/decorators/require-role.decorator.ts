import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ROLE_KEY = 'requireRole';

// A route carrying this decorator additionally requires the caller to
// hold an active platform-role grant (identity.user_roles, key = roleKey)
// — checked by PlatformRoleGuard, which must run after JwtAuthGuard in
// @UseGuards(...) (it reads request.user.sub, set by JwtAuthGuard).
export const RequireRole = (roleKey: string) => SetMetadata(REQUIRE_ROLE_KEY, roleKey);
