import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditHashService } from './audit-hash.service';

// Imported by ModerationModule (Audit B) and AuthModule (Audit C).
@Module({
  providers: [AuditService, AuditHashService],
  exports: [AuditService, AuditHashService],
})
export class AuditModule {}
