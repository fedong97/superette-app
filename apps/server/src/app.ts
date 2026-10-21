import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { type ServerConfig, loadConfig } from './config';

export type { ServerConfig } from './config';

export async function createApp(config: ServerConfig = loadConfig()) {
  const app = await NestFactory.create(AppModule.forConfig(config), { bodyParser: false, logger: ['error', 'warn', 'log'] });
  // Sauvegarde en ligne d'un PC : 200 Mo de fichier chiffré, en base64 (un tiers de plus).
  app.use('/api/v1/station-backups', json({ limit: '300mb' }));
  app.use(json({ limit: '25mb' }));
  app.enableShutdownHooks();
  return app;
}
