import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PostsController } from './posts.controller';
import { CommentsController } from './comments.controller';
import { ReactionsController } from './reactions.controller';
import { SharesController } from './shares.controller';
import { PostsService } from './posts.service';
import { CommentsService } from './comments.service';
import { ReactionsService } from './reactions.service';
import { SharesService } from './shares.service';
import { PostAccessService } from './post-access.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { CommunitiesModule } from '../communities/communities.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  imports: [
    // Reuses ProfileVisibilityService — same instance/rule as profiles
    // and social-graph, not a re-declared copy.
    ProfilesModule,
    // CommunityAccessService: the membership rules for posting in a community
    // and for the community audience of its posts.
    CommunitiesModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [PostsController, CommentsController, ReactionsController, SharesController],
  providers: [
    PostsService,
    CommentsService,
    ReactionsService,
    SharesService,
    PostAccessService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    CsrfGuard,
  ],
})
export class ContentModule {}
