import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ActionsService, type ActionResponse } from './actions.service';
import { CreateActionDto } from './dto/create-action.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformRoleGuard } from '../common/guards/platform-role.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { RequireRole } from '../common/decorators/require-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

type Me = { sub: string };

// @RequireRole is read off the HANDLER, not the controller class (see
// CasesController's own comment — Increment A discovered this the hard
// way) — repeated here even though this controller has only one route,
// for consistency and to avoid re-discovering the same bug later if a
// second route is ever added.
@ApiTags('Moderation')
@Controller('moderation')
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  @Post('cases/:caseId/actions')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, PlatformRoleGuard, CsrfGuard)
  @RequireRole('moderator')
  async create(@CurrentUser() user: Me, @Param('caseId', ParseUuidPipe) caseId: string, @Body() dto: CreateActionDto): Promise<{ data: ActionResponse }> {
    return { data: await this.actions.createAction(user.sub, caseId, dto) };
  }
}
