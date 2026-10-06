import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './config';

export async function createApp(config = loadConfig()) {
  const app = await NestFactory.create(AppModule.forConfig(config), { bodyParser: false, logger: ['error', 'warn', 'log'] });
  app.use(json({ limit: '25mb' }));
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  const config = loadConfig();
  void createApp(config).then(async (app) => {
    await app.listen(config.port);
    console.log(`Serveur Superette à l'écoute sur le port ${config.port}`);
  });
}
