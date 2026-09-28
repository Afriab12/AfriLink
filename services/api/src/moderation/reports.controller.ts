import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReportsService, type ModerationReportResponse, type ReportResponse } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';
import { CursorQueryDto } from '../common/dto/cursor-query.dto';
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

@ApiTags('Moderation')
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('reports')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async create(@CurrentUser() user: Me, @Body() dto: CreateReportDto): Promise<{ data: ReportResponse }> {
    return { data: await this.reports.createReport(user.sub, dto) };
  }

  @Get('me/reports')
  @UseGuards(JwtAuthGuard)
  async listMine(@CurrentUser() user: Me, @Query() query: CursorQueryDto): Promise<{ data: ReportResponse[] } & PageMeta> {
    const { data, nextCursor, hasMore } = await this.reports.listMyReports(user.sub, query);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }

  @Get('reports/:reportId')
  @UseGuards(JwtAuthGuard)
  async get(@CurrentUser() user: Me, @Param('reportId', ParseUuidPipe) reportId: string): Promise<{ data: ReportResponse }> {
    return { data: await this.reports.getReport(user.sub, reportId) };
  }

  @Get('moderation/reports')
  @UseGuards(JwtAuthGuard, PlatformRoleGuard)
  @RequireRole('moderator')
  async listForModeration(@Query() query: ListReportsQueryDto): Promise<{ data: ModerationReportResponse[] } & PageMeta> {
    const { data, nextCursor, hasMore } = await this.reports.listModerationReports(query);
    return { data, meta: { page: { nextCursor, hasMore } } };
  }
}
