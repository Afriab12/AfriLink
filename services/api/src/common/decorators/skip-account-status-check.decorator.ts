import { SetMetadata } from '@nestjs/common';

export const SKIP_ACCOUNT_STATUS_CHECK_KEY = 'skipAccountStatusCheck';

// A restricted/suspended/banned account must still be able to end its own
// sessions — JwtAuthGuard's request-time account-status check (which
// otherwise rejects every non-active account with 403 ACCOUNT_RESTRICTED)
// skips that one check for a route carrying this decorator. The
// session-revocation check (a revoked session's token is always rejected)
// still applies regardless — this only exempts the account-status half.
export const SkipAccountStatusCheck = () => SetMetadata(SKIP_ACCOUNT_STATUS_CHECK_KEY, true);
