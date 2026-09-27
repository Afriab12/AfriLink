import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountSanctionService } from './account-sanction.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AccountSanctionService, JwtAuthGuard, CsrfGuard],
  // AccountSanctionService is the §7 cross-module contract surface —
  // exported so Moderation (once it exists) can import AuthModule and
  // inject it, same boundary ContentModule/MessagingModule/
  // CommunitiesModule already export their own moderation services
  // through. AuthService itself is deliberately not exported — no
  // existing provider boundary changes.
  exports: [AccountSanctionService],
})
export class AuthModule {}
