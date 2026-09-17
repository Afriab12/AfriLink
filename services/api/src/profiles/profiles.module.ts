import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { ProfileVisibilityService } from './profile-visibility.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  // JwtModule is re-registered here (same secret/env var as AuthModule)
  // because JwtAuthGuard/OptionalJwtAuthGuard need JwtService resolved
  // within this module's own DI container — @UseGuards() resolves guards
  // from the controller's module, not the module the guard class happens
  // to live in.
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [ProfilesController],
  providers: [ProfilesService, ProfileVisibilityService, JwtAuthGuard, OptionalJwtAuthGuard, CsrfGuard],
  // ProfileVisibilityService is exported so SocialGraphModule can reuse
  // the identical visibility rule for followers/following lists.
  exports: [ProfileVisibilityService],
})
export class ProfilesModule {}
