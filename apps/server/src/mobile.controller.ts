import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toString as qrSvg } from 'qrcode';
import { AdminService } from './admin.service';
import { ApprovalsService } from './approvals.service';
import { ManagerService } from './manager.service';
import { MobileService, type MobileCountInput } from './mobile.service';
import { ManagerActionsService } from './managerActions.service';
import { PushService } from './push.service';
import { INVENTORY_PAGE } from './admin.page';

const SESSION = 'x-fedonix-session';

const cookieOf = (req: Request): string | undefined =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === 'fedo_admin')?.[1];

/**
 * Application Android « ONIX 360 Mobile » (`/api/v1/mobile/…`) et
 * page du gérant qui relie les téléphones et suit les comptages (`/gerant/inventaire`).
 */
@Controller()
export class MobileController {
  constructor(
    @Inject(MobileService) private readonly mobile: MobileService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(ManagerService) private readonly manager: ManagerService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ManagerActionsService) private readonly actions: ManagerActionsService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  // ——— Gérant sur le téléphone : à valider, ventes du jour, actions exécutées par un PC ———

  @Get('api/v1/mobile/manager/inbox')
  async managerInbox(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller);
    return { ...(await this.actions.inbox(caller)), approvals: await this.approvals.pending(caller.device.store_id) };
  }

  @Get('api/v1/mobile/manager/sales')
  async managerSales(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Query('day') day?: string) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller);
    return this.actions.sales(caller, day);
  }

  @Get('api/v1/mobile/manager/team')
  async managerTeam(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller);
    return this.actions.team(caller);
  }

  @Get('api/v1/mobile/manager/actions')
  async managerMyActions(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller);
    return { actions: await this.actions.mine(caller) };
  }

  @Post('api/v1/mobile/manager/actions')
  @HttpCode(200)
  async managerAct(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: Parameters<ManagerActionsService['push']>[1]) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller, true);
    return this.actions.push(caller, body);
  }

  /** Réglages Firebase pour l'appli (null : notifications pas encore réglées sur ce serveur). */
  @Get('api/v1/mobile/push')
  async pushSetup(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    const caller = await this.mobile.caller(auth, session);
    if (caller.guest) return { firebase: null };
    const status = await this.push.status();
    return { firebase: status.configured ? await this.push.client() : null };
  }

  /** Téléphone Android abonné aux notifications (Firebase) : il les reçoit appli fermée. */
  @Post('api/v1/mobile/push')
  @HttpCode(200)
  async pushToken(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: { token?: string | null }) {
    const caller = await this.mobile.caller(auth, session);
    return this.push.register(caller, body?.token ?? null);
  }

  // ——— Téléphone ———

  @Post('api/v1/mobile/pair')
  @HttpCode(200)
  pair(@Body() body: { code?: string; guest?: string; name?: string }) {
    return this.mobile.pair(body);
  }

  @Post('api/v1/mobile/login')
  @HttpCode(200)
  async login(@Headers('authorization') auth: string | undefined, @Body() body: { login: string; pin: string }) {
    return this.mobile.login(await this.mobile.device(auth), body);
  }

  @Post('api/v1/mobile/guest')
  @HttpCode(200)
  async guest(@Headers('authorization') auth: string | undefined, @Body() body: { code: string }) {
    return this.mobile.loginGuest(await this.mobile.device(auth), body);
  }

  @Post('api/v1/mobile/logout')
  @HttpCode(200)
  logout(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.logout(auth, session);
  }

  @Get('api/v1/mobile/catalog')
  async catalog(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Query('since') since?: string) {
    const caller = await this.mobile.caller(auth, session);
    return this.mobile.catalog(since, caller.device.store_id);
  }

  @Get('api/v1/mobile/find')
  async find(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Query('q') q?: string) {
    const caller = await this.mobile.caller(auth, session);
    return this.mobile.find(q ?? '', caller.device.store_id);
  }

  @Get('api/v1/mobile/articles/:id/thumb')
  async thumb(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Param('id') id: string) {
    await this.mobile.caller(auth, session);
    return this.mobile.thumb(id);
  }

  @Post('api/v1/mobile/carts')
  @HttpCode(200)
  async pushCart(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: Parameters<MobileService['pushCart']>[1]) {
    return this.mobile.pushCart(await this.mobile.caller(auth, session), body);
  }

  @Post('api/v1/mobile/carts/:id/cancel')
  @HttpCode(200)
  async cancelCart(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Param('id') id: string) {
    return this.mobile.cancelCart(await this.mobile.caller(auth, session), id);
  }

  @Get('api/v1/mobile/customers')
  async customers(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Query('q') q?: string) {
    return this.mobile.customers(await this.mobile.caller(auth, session), q ?? '');
  }

  // ——— Gérant sur le téléphone ———

  /** Tableau du gérant pour son magasin : journée, semaine, mois, vendeurs, caisses, stock, alertes, magasin en direct. */
  @Get('api/v1/mobile/manager')
  async managerHome(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Query('day') day?: string) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller);
    const storeId = caller.device.store_id;
    const board = await this.manager.dashboard(day || undefined);
    const store = board.stores.find((x) => x.id === storeId) ?? null;
    return {
      day: board.day,
      today: board.today,
      generatedAt: board.generatedAt,
      store,
      alerts: board.alerts.filter((a) => !a.store || a.store === store?.name),
      periods: await this.manager.periods(storeId),
      floor: await this.mobile.floor(caller),
      approvals: (await this.approvals.pending(storeId)).length,
      write: (await this.mobile.rights(caller)).manage === 'full',
    };
  }

  @Get('api/v1/mobile/manager/approvals')
  async managerApprovals(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller);
    return { approvals: await this.approvals.pending(caller.device.store_id) };
  }

  @Post('api/v1/mobile/manager/approvals/:id')
  @HttpCode(200)
  async managerDecide(
    @Headers('authorization') auth: string | undefined,
    @Headers(SESSION) session: string | undefined,
    @Param('id') id: string,
    @Body() body: { approve: boolean; pin?: string },
  ) {
    const caller = await this.mobile.caller(auth, session);
    await this.mobile.managerGuard(caller, true);
    return this.approvals.decide(id, body ?? { approve: false }, caller.device.store_id);
  }

  @Get('api/v1/mobile/manager/orders')
  async managerOrders(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.managerOrders(await this.mobile.caller(auth, session));
  }

  @Get('api/v1/mobile/manager/receivables')
  async managerReceivables(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.receivables(await this.mobile.caller(auth, session));
  }

  @Get('api/v1/mobile/manager/articles/:id')
  async managerArticle(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Param('id') id: string) {
    return this.mobile.managerArticle(await this.mobile.caller(auth, session), id);
  }

  @Post('api/v1/mobile/manager/articles/:id/price')
  @HttpCode(200)
  async managerPrice(
    @Headers('authorization') auth: string | undefined,
    @Headers(SESSION) session: string | undefined,
    @Param('id') id: string,
    @Body() body: { price?: number; pin?: string },
  ) {
    return this.mobile.setStorePrice(await this.mobile.caller(auth, session), id, body);
  }

  @Post('api/v1/mobile/missed')
  @HttpCode(200)
  async missed(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: Parameters<MobileService['recordMissed']>[1]) {
    return this.mobile.recordMissed(await this.mobile.caller(auth, session), body);
  }

  @Get('api/v1/mobile/exit')
  async exitLookup(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Query('code') code?: string) {
    return this.mobile.exitLookup(await this.mobile.caller(auth, session), code ?? '');
  }

  @Post('api/v1/mobile/exit')
  @HttpCode(200)
  async exitRecord(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: Parameters<MobileService['exitRecord']>[1]) {
    return this.mobile.exitRecord(await this.mobile.caller(auth, session), body);
  }

  @Get('api/v1/mobile/articles/:id/info')
  async productInfo(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Param('id') id: string) {
    return this.mobile.productInfo(await this.mobile.caller(auth, session), id);
  }

  @Get('api/v1/mobile/reception-orders')
  async receptionOrders(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.receptionOrders(await this.mobile.caller(auth, session));
  }

  @Post('api/v1/mobile/receptions')
  @HttpCode(200)
  async pushReception(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: Parameters<MobileService['pushReception']>[1]) {
    return this.mobile.pushReception(await this.mobile.caller(auth, session), body);
  }

  @Get('api/v1/mobile/receptions')
  async myReceptions(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.myReceptions(await this.mobile.caller(auth, session));
  }

  @Get('api/v1/mobile/carts')
  async myCarts(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.myCarts(await this.mobile.caller(auth, session));
  }

  @Get('api/v1/mobile/inventories')
  async inventories(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.inventories(await this.mobile.caller(auth, session));
  }

  @Post('api/v1/mobile/counts')
  @HttpCode(200)
  async counts(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: { counts: MobileCountInput[]; sentAt?: string }) {
    return this.mobile.pushCounts(await this.mobile.caller(auth, session), body?.counts, body?.sentAt);
  }

  @Post('api/v1/mobile/unknowns')
  @HttpCode(200)
  async unknown(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: Parameters<MobileService['addUnknown']>[1]) {
    return this.mobile.addUnknown(await this.mobile.caller(auth, session), body);
  }

  // ——— Gérant ———

  private guard(req: Request) {
    if (!this.admin.isSession(cookieOf(req))) throw new UnauthorizedException('Connectez-vous');
  }

  /** Adresses du serveur mises dans les QR codes : celle du gérant puis celles du réseau du magasin. */
  private urls(req: Request) {
    const host = req.headers.host && !/^(localhost|127\.|\[::1\])/.test(req.headers.host) ? [`${req.protocol}://${req.headers.host}`] : [];
    return [...new Set([...host, ...this.admin.addresses()])].slice(0, 4);
  }

  @Get('gerant/inventaire')
  page(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(INVENTORY_PAGE);
  }

  @Get('admin/api/mobile')
  async overview(@Req() req: Request) {
    this.guard(req);
    return { ...(await this.mobile.overview()), firebase: await this.push.status().catch(() => null) };
  }

  /**
   * QR code à scanner avec l'application : adresses du serveur (réseau du
   * magasin et adresse utilisée par le gérant) et code d'une seule utilisation.
   */
  @Post('admin/api/mobile/pairing')
  @HttpCode(200)
  async pairing(@Req() req: Request, @Body() body: { storeId: string }) {
    this.guard(req);
    const pairing = await this.mobile.createPairing(body?.storeId);
    const urls = this.urls(req);
    const content = `FEDONIX360:${JSON.stringify({ u: urls, c: pairing.code })}`;
    return { ...pairing, urls, qr: await qrSvg(content, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) };
  }

  /** Accès d'un aide sans compte : code à 6 chiffres et QR code qui relie aussi son téléphone. */
  @Post('admin/api/mobile/guests')
  @HttpCode(200)
  async createGuest(@Req() req: Request, @Body() body: { inventoryId: string; name: string; onBehalfOf: string; hours?: number }) {
    this.guard(req);
    const guest = await this.mobile.createGuest(body);
    const content = `FEDONIX360:${JSON.stringify({ u: this.urls(req), g: guest.code })}`;
    return { ...guest, qr: await qrSvg(content, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) };
  }

  @Post('admin/api/mobile/guests/:id/revoke')
  @HttpCode(200)
  revokeGuest(@Req() req: Request, @Param('id') id: string) {
    this.guard(req);
    return this.mobile.revokeGuest(id);
  }

  @Post('admin/api/mobile/assign')
  @HttpCode(200)
  assign(@Req() req: Request, @Body() body: { inventoryId: string; userId: string; departmentIds: string[] }) {
    this.guard(req);
    return this.mobile.assign(body);
  }

  /** Notifications Android (Firebase) : état, et compte de service collé depuis la page Téléphones. */
  @Get('admin/api/mobile/firebase')
  firebase(@Req() req: Request) {
    this.guard(req);
    return this.push.status();
  }

  @Post('admin/api/mobile/firebase')
  @HttpCode(200)
  setFirebase(@Req() req: Request, @Body() body: { json?: string | null }) {
    this.guard(req);
    return this.push.configure(body?.json ?? null);
  }

  @Post('admin/api/mobile/settings')
  @HttpCode(200)
  settings(@Req() req: Request, @Body() body: { showExpected?: boolean; recount?: boolean; seller?: string; manager?: string }) {
    this.guard(req);
    return this.mobile.saveSettings(body ?? {});
  }

  @Post('admin/api/mobile/devices/:id/revoke')
  @HttpCode(200)
  revoke(@Req() req: Request, @Param('id') id: string) {
    this.guard(req);
    return this.mobile.revoke(id);
  }

  @Post('admin/api/mobile/unknowns/:id/done')
  @HttpCode(200)
  done(@Req() req: Request, @Param('id') id: string) {
    this.guard(req);
    return this.mobile.unknownDone(id);
  }

  @Get('admin/api/mobile/unknowns/:id/photo')
  async photo(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    this.guard(req);
    const photo = await this.mobile.unknownPhoto(id);
    if (!photo) return res.status(404).end();
    res.setHeader('Content-Type', photo.type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(photo.data);
  }
}
