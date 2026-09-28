import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccountAppealsController } from './account-appeals.controller';
import { AccountAppealsService } from './account-appeals.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';
import { AuthModule } from '../auth/auth.module';
import { ContentModule } from '../content/content.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommunitiesModule } from '../communities/communities.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformRoleGuard } from '../common/guards/platform-role.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

// AuthModule is imported for AccountSanctionService. ContentModule/
// MessagingModule/CommunitiesModule are imported for their own moderation-
// callee services (ContentModerationService/MessagingModerationService/
// CommunityModerationService) — ReportsService needs their privileged,
// visibility-independent resolveXOwnerId lookups for report target
// validation (moderation.md §2's "real target + reporter may not currently
// see it -> allowed; nonexistent target -> reject" rule). Each is the same
// cross-module contract surface those modules already export for exactly
// this purpose. Actions/Sanctions/Appeals-lifecycle (beyond the existing
// account-appeal credential flow) and moderator queues for those are not
// built here — Reports + Cases only.
// JwtAuthGuard/PlatformRoleGuard/CsrfGuard are redeclared as local
// providers, same convention Content/Messaging/Communities already use for
// these guards (they are not exported through a shared module) — Reports/
// Cases are this module's first routes that need real authentication.
@Module({
  imports: [
    AuthModule,
    ContentModule,
    MessagingModule,
    CommunitiesModule,
    JwtModule.register({ secret: process.env.JWT_ACCESS_SECRET }),
  ],
  controllers: [AccountAppealsController, ReportsController, CasesController],
  providers: [AccountAppealsService, ReportsService, CasesService, JwtAuthGuard, PlatformRoleGuard, CsrfGuard],
})
export class ModerationModule {}
