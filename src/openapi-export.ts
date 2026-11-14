/**
 * Writes the OpenAPI contract to openapi.json. It lives in src so `nest build` applies the
 * Swagger plugin that derives response schemas from the DTO classes. The web repository vendors a copy and
 * generates its typed client from it, so the two repositories stay decoupled.
 *   npm run openapi:export (builds first)
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { buildOpenApiConfig } from './main';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  writeFileSync(resolve(process.cwd(), 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  console.log(`Wrote openapi.json with ${Object.keys(document.paths).length} paths`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
