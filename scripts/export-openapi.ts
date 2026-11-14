/**
 * Writes the OpenAPI contract to openapi.json. The web repository vendors a copy and
 * generates its typed client from it, so the two repositories stay decoupled.
 *   npm run openapi:export
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { buildOpenApiConfig } from '../src/main';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  writeFileSync(resolve(__dirname, '../openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`Wrote openapi.json with ${Object.keys(document.paths).length} paths`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
