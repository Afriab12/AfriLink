import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CasesService, type CaseDetailResponse, type CaseSummaryResponse } from './cases.service';
import { CreateCaseDto } from './dto/create-case.dto';
import { AssignCaseDto } from './dto/assign-case.dto';
import { UpdateCasePriorityDto } from './dto/update-case-priority.dto';
import { ListCasesQueryDto } from './dto/list-cases-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformRoleGuard } from '../common/guards/platform-role.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { RequireRole } from '../common/decorators/require-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

interface PageMeta {
  meta: { page: { nextCursor: string | null; hasMore: boolean } };
}

type Me = { sub: string };

// @RequireRole is read off the HANDLER by PlatformRoleGuard (Reflector.get
// against context.getHandler()), not the controller class — so it must be
// repeated on every method here, same as platform-role-guard.e2e-spec.ts's
// reference composition and ReportsController.listForModeration. A single
// class-level decorator would silently no-op (Reflector finds nothing on
// the handler, requiredRole is undefined, PlatformRoleGuard returns true).
@ApiTags('Moderation')
@Controller('moderation')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get('cases')
  @UseGuards(JwtAuthGuard, PlatformRoleGuard)
  @RequireRole('moderator')
  async list(@CurrentUser() user: Me, @Query() query: ListCasesQueryDto): Promise<{ data: CaseSummaryResponse[] } & PageMeta> {
    const { data, nextCursor, hasMore } = await this.cases.listCases(query, user.sub);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Get('cases/:caseId')
  @UseGuards(JwtAuthGuard, PlatformRoleGuard)
  @RequireRole('moderator')
  async get(@Param('caseId', ParseUuidPipe) caseId: string): Promise<{ data: CaseDetailResponse }> {
    return { data: await this.cases.getCase(caseId) };
  }

  @Post('cases')
  @UseGuards(JwtAuthGuard, PlatformRoleGuard, CsrfGuard)
  @RequireRole('moderator')
  async create(@Body() dto: CreateCaseDto): Promise<{ data: CaseDetailResponse }> {
    return { data: await this.cases.createCase(dto) };
  }

  @Post('cases/:caseId/assign')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PlatformRoleGuard, CsrfGuard)
  @RequireRole('moderator')
  async assign(@CurrentUser() user: Me, @Param('caseId', ParseUuidPipe) caseId: string, @Body() dto: AssignCaseDto): Promise<{ data: CaseSummaryResponse }> {
    return { data: await this.cases.assignCase(caseId, user.sub, dto) };
  }

  @Patch('cases/:caseId')
  @UseGuards(JwtAuthGuard, PlatformRoleGuard, CsrfGuard)
  @RequireRole('moderator')
  async updatePriority(@Param('caseId', ParseUuidPipe) caseId: string, @Body() dto: UpdateCasePriorityDto): Promise<{ data: CaseSummaryResponse }> {
    return { data: await this.cases.updateCasePriority(caseId, dto) };
  }

  @Post('cases/:caseId/close')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PlatformRoleGuard, CsrfGuard)
  @RequireRole('moderator')
  async close(@Param('caseId', ParseUuidPipe) caseId: string): Promise<{ data: CaseSummaryResponse }> {
    return { data: await this.cases.closeCase(caseId) };
  }
}
