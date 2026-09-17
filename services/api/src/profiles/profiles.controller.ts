import { Body, Controller, Get, Param, Patch, Put, UseGuards } from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SetInterestsDto } from './dto/set-interests.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalCurrentUser } from '../common/decorators/optional-current-user.decorator';

@Controller()
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get('me/profile')
  @UseGuards(JwtAuthGuard)
  async getOwnProfile(@CurrentUser() user: { sub: string }) {
    const profile = await this.profilesService.getOwnProfile(user.sub);
    return { data: profile };
  }

  @Patch('me/profile')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async updateOwnProfile(@CurrentUser() user: { sub: string }, @Body() dto: UpdateProfileDto) {
    const profile = await this.profilesService.updateOwnProfile(user.sub, dto);
    return { data: profile };
  }

  @Get('me/interests')
  @UseGuards(JwtAuthGuard)
  async getOwnInterests(@CurrentUser() user: { sub: string }) {
    const interests = await this.profilesService.getOwnInterests(user.sub);
    return { data: interests };
  }

  @Put('me/interests')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async setInterests(@CurrentUser() user: { sub: string }, @Body() dto: SetInterestsDto) {
    const interests = await this.profilesService.setInterests(user.sub, dto.interestIds);
    return { data: interests };
  }

  @Get('profiles/:userIdOrHandle')
  @UseGuards(OptionalJwtAuthGuard)
  async getProfile(
    @OptionalCurrentUser() viewer: { sub: string } | undefined,
    @Param('userIdOrHandle') userIdOrHandle: string,
  ) {
    const profile = await this.profilesService.getProfileFor(viewer?.sub, userIdOrHandle);
    return { data: profile };
  }

  @Get('countries')
  async listCountries() {
    const countries = await this.profilesService.listCountries();
    return { data: countries };
  }

  @Get('interests')
  async listInterests() {
    const interests = await this.profilesService.listInterests();
    return { data: interests };
  }
}
