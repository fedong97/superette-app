import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { CONFIG, type ServerConfig } from './config';
import { PG, migrate } from './database';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  static forConfig(config: ServerConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [SyncController],
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: PG,
          useFactory: async () => {
            const pool = new Pool({ connectionString: config.databaseUrl });
            await migrate(pool);
            return pool;
          },
        },
        SyncService,
      ],
    };
  }

  async onApplicationShutdown() {
    await this.pg.end();
  }
}
