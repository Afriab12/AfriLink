import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { buildOpenApiDocument } from './openapi.config';

async function bootstrap() {
  if (!process.env.JWT_ACCESS_SECRET) {
    throw new Error('JWT_ACCESS_SECRET must be set — see .env.example');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set — see .env.example');
  }

  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? true,
    credentials: true,
  });

  // Always generated fresh from the live decorated controllers/DTOs at
  // boot — never a hand-maintained document that can drift from the
  // real routes. See generate-openapi.ts for the static-file equivalent.
  SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
