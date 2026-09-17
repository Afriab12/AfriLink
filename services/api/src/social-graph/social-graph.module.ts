import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SocialGraphController } from './social-graph.controller';
import { SocialGraphService } from './social-graph.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  imports: [
    // Reuses ProfileVisibilityService exported by ProfilesModule — same
    // instance, same rule, not a re-declared copy (judgment call 6).
    ProfilesModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [SocialGraphController],
  providers: [SocialGraphService, JwtAuthGuard, OptionalJwtAuthGuard, CsrfGuard],
})
export class SocialGraphModule {}
