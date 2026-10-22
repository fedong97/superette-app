import { createApp } from './app';
import { loadConfig } from './config';

export { createApp } from './app';

if (require.main === module) {
  const config = loadConfig();
  void createApp(config).then(async (app) => {
    await app.listen(config.port);
    console.log(`Serveur ONIX 360 à l'écoute sur le port ${config.port}`);
    console.log(`Interface : http://localhost:${config.port}/`);
  });
}
