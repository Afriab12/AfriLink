import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaAccessService } from './media-access.service';
import { MediaStorageService } from './media-storage.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService, MediaAccessService, MediaStorageService, JwtAuthGuard, CsrfGuard],
  // MediaAccessService is the ownership/purpose/readiness authority other
  // modules are meant to consume (docs/05-api/media.md §7) once their own
  // attachment increments are approved — not yet wired into any of them.
  exports: [MediaAccessService],
})
export class MediaModule {}
