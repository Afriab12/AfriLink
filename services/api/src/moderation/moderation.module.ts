import { Module } from '@nestjs/common';
import { AccountAppealsController } from './account-appeals.controller';
import { AccountAppealsService } from './account-appeals.service';
import { AuthModule } from '../auth/auth.module';

// The first slice of a Moderation module — only what the account-appeal
// credential flow needs (docs/05-api/moderation.md §5). AuthModule is
// imported for AccountSanctionService, which it already exports (the same
// cross-module contract surface Content/Messaging/Communities each expose
// their own moderation callee through). The full Moderation surface
// (reports, cases, actions, the session-based appeal route, moderator
// queues) is not built here.
@Module({
  imports: [AuthModule],
  controllers: [AccountAppealsController],
  providers: [AccountAppealsService],
})
export class ModerationModule {}
