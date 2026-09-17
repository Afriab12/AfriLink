// AfriLink Prisma 7 CLI configuration.
//
// Prisma 7 removed `datasource.url` from schema.prisma (see the comment in
// schema.prisma's datasource block) — the connection URL and migrations
// path now live here instead, following the exact pattern the installed
// Prisma 7.10.0 CLI itself generates via `prisma init` (filename included:
// this version names the file `prisma7.config.ts`, not `prisma.config.ts`).
//
// NOTE: this file imports `dotenv/config` to load a local `.env` file,
// matching Prisma's own generated template. `dotenv` is not currently a
// dependency in database/package.json — add it (`npm install --save-dev
// dotenv`) before this file is actually run, or set DATABASE_URL directly
// in the environment instead. Not added automatically here since adding a
// new package wasn't part of what was asked this turn.
//
// NOT YET USED — no `prisma migrate`/`db push`/`db pull`/`generate` has
// been run with this config; created for review only.

import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "schema.prisma",
  migrations: {
    path: "migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
