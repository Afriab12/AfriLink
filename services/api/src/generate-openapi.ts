import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi.config';

// Static-file equivalent of the /api/docs runtime endpoint (main.ts) —
// for the separate frontend team to fetch the spec, and for CI to
// verify document generation still succeeds, without running a live
// server. Not committed to git (see .gitignore); always regenerated
// from current source, so it can never go stale on disk.
async function generate() {
  if (!process.env.JWT_ACCESS_SECRET) {
    throw new Error('JWT_ACCESS_SECRET must be set — see .env.example');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set — see .env.example');
  }

  const app = await NestFactory.create(AppModule, { logger: false });
  const document = buildOpenApiDocument(app);

  const outDir = join(process.cwd(), 'openapi');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'openapi.json'), JSON.stringify(document, null, 2));

  await app.close();
  console.log('OpenAPI spec written to openapi/openapi.json');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
