import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AppealsService, type AppealResponse } from './appeals.service';
import { DecideAppealDto } from './dto/decide-appeal.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformRoleGuard } from '../common/guards/platform-role.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { RequireRole } from '../common/decorators/require-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

type Me = { sub: string };

// Increment B3, decision processing only (approved Option B) — session-
// based appeal submission and the GET read surfaces (queue, detail,
// /me/appeals) are deferred to a future increment.
@ApiTags('Moderation')
@Controller('moderation')
export class AppealsController {
  constructor(private readonly appeals: AppealsService) {}

  @Post('appeals/:appealId/decide')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PlatformRoleGuard, CsrfGuard)
  @RequireRole('moderator')
  async decide(@CurrentUser() user: Me, @Param('appealId', ParseUuidPipe) appealId: string, @Body() dto: DecideAppealDto): Promise<{ data: AppealResponse }> {
    return { data: await this.appeals.decideAppeal(user.sub, appealId, dto) };
  }
}
