import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { SocialGraphModule } from './social-graph/social-graph.module';
import { ContentModule } from './content/content.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RateLimitGuard } from './common/guards/rate-limit.guard';

@Module({
  imports: [PrismaModule, AuthModule, ProfilesModule, SocialGraphModule, ContentModule, MessagingModule],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
