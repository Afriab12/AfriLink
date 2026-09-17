import { Injectable } from '@nestjs/common';
import type { Profile } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ResourceNotFoundException, ValidationFailedException } from '../common/errors/api-exception';
import { ProfileVisibilityService } from './profile-visibility.service';
import type { UpdateProfileDto } from './dto/update-profile.dto';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProfileResponse {
  userId: string;
  displayName: string | null;
  bio: string | null;
  countryCode: string | null;
  region: string | null;
  websiteUrl: string | null;
  visibility: string;
  primaryLanguage: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: ProfileVisibilityService,
  ) {}

  // avatarMediaId and profileMetadata are never serialized to clients —
  // see UpdateProfileDto's header comment for why.
  private toResponse(profile: Profile): ProfileResponse {
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      bio: profile.bio,
      countryCode: profile.countryCode,
      region: profile.region,
      websiteUrl: profile.websiteUrl,
      visibility: profile.visibility,
      primaryLanguage: profile.primaryLanguage,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  private defaultResponse(userId: string): ProfileResponse {
    return {
      userId,
      displayName: null,
      bio: null,
      countryCode: null,
      region: null,
      websiteUrl: null,
      visibility: 'public',
      primaryLanguage: 'en',
      createdAt: null,
      updatedAt: null,
    };
  }

  // Registration (auth module) never creates a Profile row — the first
  // time the owner touches their own profile, one is created on the fly.
  async getOwnProfile(userId: string): Promise<ProfileResponse> {
    const profile = await this.prisma.profile.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
    return this.toResponse(profile);
  }

  async updateOwnProfile(userId: string, dto: UpdateProfileDto): Promise<ProfileResponse> {
    const countryCode = dto.countryCode?.toUpperCase();
    if (countryCode) {
      const country = await this.prisma.country.findUnique({ where: { code: countryCode } });
      if (!country || !country.isActive) {
        throw new ValidationFailedException([{ field: 'countryCode', reason: 'must be an active country code' }]);
      }
    }

    const profile = await this.prisma.profile.upsert({
      where: { userId },
      update: {
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
        ...(dto.bio !== undefined && { bio: dto.bio }),
        ...(countryCode !== undefined && { countryCode }),
        ...(dto.region !== undefined && { region: dto.region }),
        ...(dto.websiteUrl !== undefined && { websiteUrl: dto.websiteUrl }),
        ...(dto.visibility !== undefined && { visibility: dto.visibility }),
        ...(dto.primaryLanguage !== undefined && { primaryLanguage: dto.primaryLanguage }),
      },
      create: {
        userId,
        displayName: dto.displayName,
        bio: dto.bio,
        countryCode,
        region: dto.region,
        websiteUrl: dto.websiteUrl,
        visibility: dto.visibility ?? 'public',
        primaryLanguage: dto.primaryLanguage ?? 'en',
      },
    });
    return this.toResponse(profile);
  }

  // viewerId is undefined for an anonymous caller (OptionalJwtAuthGuard).
  async getProfileFor(viewerId: string | undefined, userIdOrHandle: string): Promise<ProfileResponse> {
    const target = await this.prisma.user.findFirst({
      where: UUID_PATTERN.test(userIdOrHandle) ? { id: userIdOrHandle } : { handle: userIdOrHandle },
      include: { profile: true },
    });

    // Same 404 regardless of "doesn't exist" vs "not active" vs "deleted"
    // — api.md §6: never disambiguate why a resource is unreachable.
    if (!target || target.status !== 'active' || target.deletedAt) {
      throw new ResourceNotFoundException();
    }

    await this.visibility.assertNotBlocked(viewerId, target.id);
    await this.visibility.assertCanViewProfile(viewerId, target);

    return target.profile ? this.toResponse(target.profile) : this.defaultResponse(target.id);
  }

  async listCountries() {
    return this.prisma.country.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, name: true, nameLocal: true, region: true },
    });
  }

  async listInterests() {
    return this.prisma.interest.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, slug: true, label: true, category: true },
    });
  }

  async getOwnInterests(userId: string) {
    const rows = await this.prisma.userInterest.findMany({
      where: { userId },
      include: { interest: true },
      orderBy: { interest: { sortOrder: 'asc' } },
    });
    return rows.map((r) => ({ id: r.interest.id, slug: r.interest.slug, label: r.interest.label, category: r.interest.category }));
  }

  async setInterests(userId: string, interestIds: string[]) {
    const activeInterests = await this.prisma.interest.findMany({
      where: { id: { in: interestIds }, isActive: true },
    });

    if (activeInterests.length !== interestIds.length) {
      const validIds = new Set(activeInterests.map((i) => i.id));
      const invalid = interestIds.filter((id) => !validIds.has(id));
      throw new ValidationFailedException(
        invalid.map((id) => ({ field: 'interestIds', reason: `unknown or inactive interest id: ${id}` })),
      );
    }

    await this.prisma.$transaction([
      this.prisma.userInterest.deleteMany({ where: { userId } }),
      this.prisma.userInterest.createMany({
        data: interestIds.map((interestId) => ({ userId, interestId })),
      }),
    ]);

    return this.getOwnInterests(userId);
  }
}
