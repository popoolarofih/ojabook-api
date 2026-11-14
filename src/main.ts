import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './app.setup';
import { APP_CONFIG, AppConfig } from './config/env';

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('OjaBook API')
    .setDescription(
      'Versioned contract for the OjaBook web app. Money is integer kobo. Quantities are decimal strings. ' +
        'Financial mutations require an Idempotency-Key header. Tenant routes require X-Business-Id.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app, { useLogger: true });
  const config = app.get<AppConfig>(APP_CONFIG);

  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, { jsonDocumentUrl: `${API_PREFIX}/openapi.json` });

  await app.listen(config.port, '0.0.0.0');
}

if (require.main === module) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
