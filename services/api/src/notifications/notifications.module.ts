import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  imports: [
    // Reuses ProfileVisibilityService for the block rule — the same instance
    // every other module uses, not a re-declared copy.
    ProfilesModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, JwtAuthGuard, CsrfGuard],
})
export class NotificationsModule {}
