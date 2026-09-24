// AfriLink platform-role seed
//
// Seeds identity.roles with the single MVP platform role (`moderator`),
// per the owner-approved design in docs/05-api/platform-role-authorization.md
// decision 1. Deliberately does NOT grant the role to anyone — the role
// existing and a user holding it are two separate, separately-authorized
// steps (decision 2: the first grant is a manual, per-environment,
// trusted-operator action, never part of this script or any API).
//
// Idempotent by design: upserted on the natural key (`key`), so running
// this more than once is safe. Adding a future role (e.g. `admin`) is a
// one-line data addition to ROLES below — no schema change, no new script.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// platform-role-authorization.md decision 1 — exactly one role for MVP.
const ROLES: Array<{ key: string; name: string; description: string }> = [
  {
    key: "moderator",
    name: "Moderator",
    description: "Platform-wide content and account moderation authority (Moderation API).",
  },
];

async function seedRoles() {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { key: role.key },
      update: { name: role.name, description: role.description },
      create: { key: role.key, name: role.name, description: role.description },
    });
  }
}

async function main() {
  await seedRoles();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
