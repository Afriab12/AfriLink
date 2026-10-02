import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// Not registered in app.module.ts yet — Audit A (the writer) only.
// Auth/Moderation producer wiring is a separate, later-approved increment.
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
