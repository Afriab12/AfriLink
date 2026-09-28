import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccountAppealsService, type AccountAppealResponse } from './account-appeals.service';
import { CreateAccountAppealDto } from './dto/create-account-appeal.dto';
import { RateLimit } from '../common/guards/rate-limit.decorator';

// Public route — deliberately no JwtAuthGuard. The credential itself is
// the proof of identity (docs/05-api/moderation.md §5, Decision #14/Q1–Q2):
// a suspended/banned user has no live session and normal login is
// independently rejected, so the entire point of this route is to work
// without either.
@ApiTags('Moderation')
@Controller('moderation')
export class AccountAppealsController {
  constructor(private readonly accountAppeals: AccountAppealsService) {}

  @Post('account-appeals')
  @HttpCode(201)
  @RateLimit(5, 3_600_000)
  async create(@Body() dto: CreateAccountAppealDto): Promise<{ data: AccountAppealResponse }> {
    return { data: await this.accountAppeals.submitAccountAppeal(dto) };
  }
}
