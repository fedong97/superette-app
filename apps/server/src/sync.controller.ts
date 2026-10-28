import { Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Inject, Ip, Param, Post, Query } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { CounterService } from './counter.service';
import { MobileService } from './mobile.service';
import { type SyncEvent, SyncService } from './sync.service';

/** Limite les essais de code d'activation (6 chiffres) : 10 échecs par heure et par adresse. */
const failures = new Map<string, { count: number; until: number }>();

@Controller('api/v1')
export class SyncController {
  constructor(
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(MobileService) private readonly mobile: MobileService,
    @Inject(CounterService) private readonly counter: CounterService,
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

  /** Paniers préparés au rayon par les vendeurs, pour les caisses du magasin. */
  @Get('carts')
  async carts(@Headers('authorization') auth: string | undefined) {
    return this.mobile.waitingCarts((await this.sync.authenticate(auth)).store_id);
  }

  @Post('carts/:id/take')
  @HttpCode(200)
  async takeCart(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.mobile.takeCart(await this.sync.authenticate(auth), id);
  }

  // ——— Vendeur et caissier séparés : factures envoyées à la caisse ———

  @Post('counter')
  @HttpCode(200)
  async counterSend(@Headers('authorization') auth: string | undefined, @Body() body: Parameters<CounterService['send']>[1]) {
    return this.counter.send(await this.sync.authenticate(auth), body);
  }

  /** Factures ouvertes du magasin (caisse), ou d'un vendeur (`seller`), ou de tous les vendeurs (`seller=*`). */
  @Get('counter')
  async counterList(@Headers('authorization') auth: string | undefined, @Query('seller') seller?: string) {
    const device = await this.sync.authenticate(auth);
    return { invoices: seller ? await this.counter.bySeller(device, seller === '*' ? null : seller) : await this.counter.open(device) };
  }

  @Get('counter/:id')
  async counterGet(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.counter.get(await this.sync.authenticate(auth), id);
  }

  @Post('counter/:id/:action')
  @HttpCode(200)
  async counterAction(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: { by?: string; note?: string | null; saleId?: string; saleNumber?: string },
  ) {
    const device = await this.sync.authenticate(auth);
    const by = String(body?.by ?? '');
    switch (action) {
      case 'edit':
        return this.counter.edit(device, id, by);
      case 'unedit':
        return this.counter.unedit(device, id);
      case 'take':
        return this.counter.take(device, id, by);
      case 'release':
        return this.counter.release(device, id);
      case 'return':
        return this.counter.giveBack(device, id, String(body?.note ?? ''), by);
      case 'paid':
        return this.counter.paid(device, id, String(body?.saleId ?? ''), String(body?.saleNumber ?? ''), by);
      case 'cancel':
        return this.counter.cancel(device, id, by, body?.note ?? null);
      case 'unlock':
        return this.counter.unlock(device, id);
      default:
        throw new HttpException('Action inconnue', HttpStatus.NOT_FOUND);
    }
  }

  /** État du PC (toutes les 5 minutes) et état de tous les PC du magasin. */
  @Post('devices/status')
  @HttpCode(200)
  async pushStatus(@Headers('authorization') auth: string | undefined, @Body() body: unknown) {
    return this.sync.saveStatus(await this.sync.authenticate(auth), body);
  }

  @Get('devices/status')
  async statuses(@Headers('authorization') auth: string | undefined) {
    return this.sync.statuses(await this.sync.authenticate(auth));
  }

  /** Livraisons comptées sur le téléphone, pour les PC du magasin. */
  @Get('mobile-receptions')
  async mobileReceptions(@Headers('authorization') auth: string | undefined) {
    return this.mobile.waitingReceptions((await this.sync.authenticate(auth)).store_id);
  }

  @Post('mobile-receptions/:id/take')
  @HttpCode(200)
  async takeReception(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.mobile.takeReception(await this.sync.authenticate(auth), id);
  }

  @Get('sync/pull')
  async pull(@Headers('authorization') auth: string | undefined, @Headers('x-fedonix-version') version: string | undefined, @Query('since') since?: string, @Query('limit') limit?: string) {
    const device = await this.sync.authenticate(auth, version);
    return this.sync.pull(device, Number(since ?? 0), Number(limit ?? 1000));
  }
}
