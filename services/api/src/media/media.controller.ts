import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MediaService, type MediaResponse, type UploadCompleteResponse, type UploadInitResponse } from './media.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseUuidPipe } from '../common/pipes/parse-uuid.pipe';

type Me = { sub: string };

// Exactly the four routes approved in docs/05-api/media.md §1 — no list
// route (api.md §15 marks Media's pagination "N/A"), no separate status
// route (state is part of GET /media/{id}'s response).
//
// Rate limiting: contract only, as everywhere else (api.md §11).
@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('uploads')
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async initUpload(@CurrentUser() user: Me, @Body() dto: CreateUploadDto): Promise<{ data: UploadInitResponse }> {
    return { data: await this.media.initUpload(user.sub, dto) };
  }

  @Post('uploads/:uploadId/complete')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async completeUpload(@CurrentUser() user: Me, @Param('uploadId', ParseUuidPipe) uploadId: string): Promise<{ data: UploadCompleteResponse }> {
    return { data: await this.media.completeUpload(user.sub, uploadId) };
  }

  @Get(':assetId')
  @UseGuards(JwtAuthGuard)
  async getMedia(@CurrentUser() user: Me, @Param('assetId', ParseUuidPipe) assetId: string): Promise<{ data: MediaResponse }> {
    return { data: await this.media.getMedia(user.sub, assetId) };
  }

  @Delete(':assetId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, CsrfGuard)
  async deleteMedia(@CurrentUser() user: Me, @Param('assetId', ParseUuidPipe) assetId: string): Promise<{ data: { deleted: boolean } }> {
    await this.media.deleteMedia(user.sub, assetId);
    return { data: { deleted: true } };
  }
}
