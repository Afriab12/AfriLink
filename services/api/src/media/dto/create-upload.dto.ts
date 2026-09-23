import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ALL_MIME_TYPES, ASSET_KINDS, ASSET_PURPOSES } from '../media.constants';

// Declared facts only — never trusted as authoritative (architecture.md §16,
// PRD §31). The service cross-checks kind/purpose pairing and the
// kind-specific MIME/size/duration ceilings (a cross-field rule, not
// expressible with decorators alone — same pattern as PostsService's
// assertVisibilityFits). The worker (not built) is what verifies for real.
export class CreateUploadDto {
  @IsIn(ASSET_KINDS)
  kind!: (typeof ASSET_KINDS)[number];

  @IsIn(ASSET_PURPOSES)
  purpose!: (typeof ASSET_PURPOSES)[number];

  @IsIn(ALL_MIME_TYPES)
  declaredMimeType!: (typeof ALL_MIME_TYPES)[number];

  @IsOptional()
  @IsInt()
  @Min(1)
  declaredByteSize?: number;

  // Non-persisted: there is no expected-duration column on media.uploads
  // (only expectedByteSize/expectedChecksum exist). Used only for an
  // upfront, non-authoritative rejection when the client happens to know
  // it — the same declared-vs-verified treatment as size/MIME/checksum,
  // just with nowhere to store the declared side.
  @IsOptional()
  @IsInt()
  @Min(1)
  declaredDurationSeconds?: number;

  @IsOptional()
  @IsString()
  declaredChecksum?: string;
}
