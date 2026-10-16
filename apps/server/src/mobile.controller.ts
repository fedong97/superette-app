import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toString as qrSvg } from 'qrcode';
import { AdminService } from './admin.service';
import { MobileService, type MobileCountInput } from './mobile.service';
import { INVENTORY_PAGE } from './admin.page';

const SESSION = 'x-fedonix-session';

const cookieOf = (req: Request): string | undefined =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === 'fedo_admin')?.[1];

/**
 * Application Android « FEDONIX 360 Inventaire » (`/api/v1/mobile/…`) et
 * page du gérant qui relie les téléphones et suit les comptages (`/gerant/inventaire`).
 */
@Controller()
export class MobileController {
  constructor(
    @Inject(MobileService) private readonly mobile: MobileService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  // ——— Téléphone ———

  @Post('api/v1/mobile/pair')
  @HttpCode(200)
  pair(@Body() body: { code: string; name?: string }) {
    return this.mobile.pair(body);
  }

  @Post('api/v1/mobile/login')
  @HttpCode(200)
  async login(@Headers('authorization') auth: string | undefined, @Body() body: { login: string; pin: string }) {
    return this.mobile.login(await this.mobile.device(auth), body);
  }

  @Post('api/v1/mobile/logout')
  @HttpCode(200)
  logout(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.logout(auth, session);
  }

  @Get('api/v1/mobile/catalog')
  async catalog(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Query('since') since?: string) {
    await this.mobile.caller(auth, session);
    return this.mobile.catalog(since);
  }

  @Get('api/v1/mobile/inventories')
  async inventories(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined) {
    return this.mobile.inventories(await this.mobile.caller(auth, session));
  }

  @Post('api/v1/mobile/counts')
  @HttpCode(200)
  async counts(@Headers('authorization') auth: string | undefined, @Headers(SESSION) session: string | undefined, @Body() body: { counts: MobileCountInput[] }) {
    return this.mobile.pushCounts(await this.mobile.caller(auth, session), body?.counts);
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

  @Get('gerant/inventaire')
  page(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(INVENTORY_PAGE);
  }

  @Get('admin/api/mobile')
  overview(@Req() req: Request) {
    this.guard(req);
    return this.mobile.overview();
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
    const host = req.headers.host && !/^(localhost|127\.|\[::1\])/.test(req.headers.host) ? [`${req.protocol}://${req.headers.host}`] : [];
    const urls = [...new Set([...host, ...this.admin.addresses()])].slice(0, 4);
    const content = `FEDONIX360:${JSON.stringify({ u: urls, c: pairing.code })}`;
    return { ...pairing, urls, qr: await qrSvg(content, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) };
  }

  @Post('admin/api/mobile/assign')
  @HttpCode(200)
  assign(@Req() req: Request, @Body() body: { inventoryId: string; userId: string; departmentIds: string[] }) {
    this.guard(req);
    return this.mobile.assign(body);
  }

  @Post('admin/api/mobile/settings')
  @HttpCode(200)
  settings(@Req() req: Request, @Body() body: { showExpected?: boolean; recount?: boolean }) {
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
