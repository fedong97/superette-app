import { Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Inject, Ip, Param, Post, Query } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { type SyncEvent, SyncService } from './sync.service';

/** Limite les essais de code d'activation (6 chiffres) : 10 échecs par heure et par adresse. */
const failures = new Map<string, { count: number; until: number }>();

@Controller('api/v1')
export class SyncController {
  constructor(
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Get('health')
  health() {
    return { ok: true, service: 'superette-server' };
  }

  @Post('devices/enroll')
  enroll(@Body() body: { enrollmentKey: string; storeId: string; registerId: string; name?: string }) {
    return this.sync.enroll(body);
  }

  @Post('devices/activate')
  async activate(@Body() body: { activationCode: string; name?: string }, @Ip() ip: string) {
    const now = Date.now();
    const f = failures.get(ip);
    if (f && f.until > now && f.count >= 10) throw new HttpException('Trop de tentatives, réessayez dans une heure', HttpStatus.TOO_MANY_REQUESTS);
    try {
      const result = await this.sync.activate(body);
      failures.delete(ip);
      return result;
    } catch (e) {
      const cur = f && f.until > now ? f : { count: 0, until: now + 3_600_000 };
      failures.set(ip, { ...cur, count: cur.count + 1 });
      throw e;
    }
  }

  @Post('sync/push')
  @HttpCode(200)
  async push(@Headers('authorization') auth: string | undefined, @Body() body: { events: SyncEvent[] }) {
    const device = await this.sync.authenticate(auth);
    return this.sync.push(device, body?.events);
  }

  @Post('sync/known')
  @HttpCode(200)
  async known(@Headers('authorization') auth: string | undefined, @Body() body: { entity: string }) {
    const device = await this.sync.authenticate(auth);
    return this.sync.known(device, String(body?.entity ?? ''));
  }

  @Post('license')
  @HttpCode(200)
  async license(@Headers('authorization') auth: string | undefined, @Body() body: { key: string }) {
    await this.sync.authenticate(auth);
    return this.sync.uploadLicense(body?.key);
  }

  /** Accord du gérant demandé depuis la caisse : il répond sur son téléphone. */
  @Post('approvals')
  @HttpCode(200)
  async requestApproval(@Headers('authorization') auth: string | undefined, @Body() body: { action: string; requestedBy?: string }) {
    return this.approvals.request(await this.sync.authenticate(auth), body);
  }

  @Get('approvals/:id')
  async approvalStatus(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.approvals.status(await this.sync.authenticate(auth), id);
  }

  @Get('sync/pull')
  async pull(@Headers('authorization') auth: string | undefined, @Headers('x-fedonix-version') version: string | undefined, @Query('since') since?: string, @Query('limit') limit?: string) {
    const device = await this.sync.authenticate(auth, version);
    return this.sync.pull(device, Number(since ?? 0), Number(limit ?? 1000));
  }
}
