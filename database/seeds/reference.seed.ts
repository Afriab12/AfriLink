// AfriLink Phase 1 reference-data seed
//
// Seeds `reference.countries` and `reference.interests` with the starter
// content approved in ADR-003 §7 (docs/10-decisions/decisions.md).
// Placeholder/starter content — editable later as plain row data, no
// migration required (see database.md §5).
//
// NOT EXECUTED. Created for review only — do not run `prisma db seed` or
// invoke this script against any database until the migration above has
// been reviewed and applied by the owner.
//
// Idempotent by design: every row is upserted on its natural key (country
// `code`, interest `slug`), so running this more than once is safe.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// Prisma 7 requires an explicit driver adapter — PrismaClient() with no
// arguments is no longer valid (see the PrismaClientInitializationError
// this replaced). DATABASE_URL is read from the environment, not hardcoded.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ADR-003 §7 — Nigeria (primary launch market) plus six other African
// countries spanning West/East/Southern/North Africa.
const COUNTRIES: Array<{
  code: string;
  name: string;
  region: string;
  sortOrder: number;
}> = [
  { code: "NG", name: "Nigeria", region: "West Africa", sortOrder: 0 },
  { code: "GH", name: "Ghana", region: "West Africa", sortOrder: 1 },
  { code: "KE", name: "Kenya", region: "East Africa", sortOrder: 2 },
  { code: "ZA", name: "South Africa", region: "Southern Africa", sortOrder: 3 },
  { code: "EG", name: "Egypt", region: "North Africa", sortOrder: 4 },
  { code: "ET", name: "Ethiopia", region: "East Africa", sortOrder: 5 },
  { code: "SN", name: "Senegal", region: "West Africa", sortOrder: 6 },
];

// ADR-003 §7 — 18-item starter interest taxonomy.
const INTERESTS: Array<{ slug: string; label: string; sortOrder: number }> = [
  { slug: "music", label: "Music", sortOrder: 0 },
  { slug: "sports", label: "Sports", sortOrder: 1 },
  { slug: "fashion-style", label: "Fashion & Style", sortOrder: 2 },
  { slug: "food-cooking", label: "Food & Cooking", sortOrder: 3 },
  { slug: "technology", label: "Technology", sortOrder: 4 },
  { slug: "business-entrepreneurship", label: "Business & Entrepreneurship", sortOrder: 5 },
  { slug: "film-tv", label: "Film & TV", sortOrder: 6 },
  { slug: "arts-culture", label: "Arts & Culture", sortOrder: 7 },
  { slug: "travel", label: "Travel", sortOrder: 8 },
  { slug: "education", label: "Education", sortOrder: 9 },
  { slug: "health-wellness", label: "Health & Wellness", sortOrder: 10 },
  { slug: "gaming", label: "Gaming", sortOrder: 11 },
  { slug: "politics-current-affairs", label: "Politics & Current Affairs", sortOrder: 12 },
  { slug: "religion-spirituality", label: "Religion & Spirituality", sortOrder: 13 },
  { slug: "comedy-entertainment", label: "Comedy & Entertainment", sortOrder: 14 },
  { slug: "photography", label: "Photography", sortOrder: 15 },
  { slug: "literature-books", label: "Literature & Books", sortOrder: 16 },
  { slug: "agriculture", label: "Agriculture", sortOrder: 17 },
];

async function seedCountries() {
  for (const country of COUNTRIES) {
    await prisma.country.upsert({
      where: { code: country.code },
      update: {
        name: country.name,
        region: country.region,
        sortOrder: country.sortOrder,
        isActive: true,
      },
      create: {
        code: country.code,
        name: country.name,
        region: country.region,
        sortOrder: country.sortOrder,
        isActive: true,
      },
    });
  }
}

async function seedInterests() {
  for (const interest of INTERESTS) {
    await prisma.interest.upsert({
      where: { slug: interest.slug },
      update: {
        label: interest.label,
        sortOrder: interest.sortOrder,
        isActive: true,
      },
      create: {
        slug: interest.slug,
        label: interest.label,
        sortOrder: interest.sortOrder,
        isActive: true,
      },
    });
  }
}

async function main() {
  await seedCountries();
  await seedInterests();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
