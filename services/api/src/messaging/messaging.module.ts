import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConversationsController } from './conversations.controller';
import { MessagesController } from './messages.controller';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { MessagingAccessService } from './messaging-access.service';
import { MessagingModerationService } from './messaging-moderation.service';
import { MessagingGateway } from './messaging.gateway';
import { ProfilesModule } from '../profiles/profiles.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  imports: [
    // Reuses ProfileVisibilityService — same instance/rule as every other
    // module, not a re-declared copy.
    ProfilesModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [ConversationsController, MessagesController],
  providers: [ConversationsService, MessagesService, MessagingAccessService, MessagingModerationService, MessagingGateway, JwtAuthGuard, CsrfGuard],
  // MessagingModerationService is the §7 cross-module contract surface —
  // exported so Moderation (once it exists) can import MessagingModule and
  // inject it, same boundary ContentModule already exports
  // ContentModerationService through. MessagesService is deliberately not
  // exported — no existing provider boundary changes.
  exports: [MessagingModerationService],
})
export class MessagingModule {}
