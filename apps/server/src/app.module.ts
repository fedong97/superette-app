import { type DynamicModule, Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BackupService } from './backup.service';
import { CONFIG, type ServerConfig } from './config';
import { type Db, PG, openDb } from './database';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { UpdatesController } from './updates.controller';
import { UpdatesService } from './updates.service';

@Module({})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(PG) private readonly pg: Db,
    @Inject(BackupService) private readonly backups: BackupService,
  ) {}

  static forConfig(config: ServerConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [SyncController, AdminController, UpdatesController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: PG, useFactory: () => openDb(config) },
        SyncService,
        AdminService,
        BackupService,
        UpdatesService,
      ],
    };
  }

  onApplicationBootstrap() {
    this.backups.start();
  }

  async onApplicationShutdown() {
    this.backups.stop();
    await this.pg.close();
  }
}
