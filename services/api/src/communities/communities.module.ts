import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CommunitiesController } from './communities.controller';
import { CommunitiesService } from './communities.service';
import { MembershipsService } from './memberships.service';
import { CommunityAccessService } from './community-access.service';
import { CommunityModerationService } from './community-moderation.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  imports: [
    // Reuses ProfileVisibilityService for the block rule, not a re-declared copy.
    ProfilesModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [CommunitiesController],
  providers: [CommunitiesService, MembershipsService, CommunityAccessService, CommunityModerationService, JwtAuthGuard, OptionalJwtAuthGuard, CsrfGuard],
  // The Content module needs the same membership rules to gate posting and
  // to apply the community audience on reads. CommunityModerationService is
  // the §7 cross-module contract surface — exported so Moderation (once it
  // exists) can import CommunitiesModule and inject it, same boundary
  // ContentModule/MessagingModule already export their own moderation
  // services through.
  exports: [CommunityAccessService, CommunityModerationService],
})
export class CommunitiesModule {}
