import { type DynamicModule, Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AlertsService } from './alerts.service';
import { ApprovalsService } from './approvals.service';
import { BackupService } from './backup.service';
import { CounterService } from './counter.service';
import { ManagerService } from './manager.service';
import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { ShopController } from './shop.controller';
import { ShopService } from './shop.service';
import { StationBackupService } from './stationBackup.service';
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
    @Inject(AlertsService) private readonly alerts: AlertsService,
  ) {}

  static forConfig(config: ServerConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [SyncController, AdminController, UpdatesController, MobileController, ShopController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: PG, useFactory: () => openDb(config) },
        SyncService,
        AdminService,
        BackupService,
        UpdatesService,
        ManagerService,
        MobileService,
        AlertsService,
        ApprovalsService,
        CounterService,
        ShopService,
        StationBackupService,
      ],
    };
  }

  onApplicationBootstrap() {
    this.backups.start();
    this.alerts.start();
  }

  async onApplicationShutdown() {
    this.backups.stop();
    this.alerts.stop();
    await this.pg.close();
  }
}
