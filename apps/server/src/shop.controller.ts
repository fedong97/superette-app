import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminService } from './admin.service';
import { PRICE_PAGE, SHOP_PAGE, closedPage } from './shop.page';
import { ShopService } from './shop.service';
import { StationBackupService } from './stationBackup.service';
import { SyncService } from './sync.service';

const cookieOf = (req: Request): string | undefined =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === 'fedo_admin')?.[1];

const html = (res: Response, status: number, body: string) => {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(body);
};

/**
 * Pages publiques du magasin (boutique en ligne, vérificateur de prix) et
 * leurs données, commandes de la boutique pour les postes, sauvegardes en
 * ligne des PC.
 */
@Controller()
export class ShopController {
  constructor(
    @Inject(ShopService) private readonly shop: ShopService,
    @Inject(StationBackupService) private readonly stationBackups: StationBackupService,
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  // ——— Boutique en ligne (public) ———

  @Get('boutique/:code')
  async shopPage(@Param('code') code: string, @Res() res: Response) {
    const store = await this.shop.store(code);
    if (!store?.settings.onlineShop) {
      return html(res, 404, closedPage('Boutique fermée en ligne', store ? `${store.name} ne prend pas de commandes en ligne pour le moment. Appelez le magasin ou passez nous voir.` : 'Aucun magasin ne porte ce code. Vérifiez l’adresse de la page.'));
    }
    return html(res, 200, SHOP_PAGE);
  }

  @Get('api/v1/shop/:code/catalog')
  catalog(@Param('code') code: string, @Ip() ip: string) {
    this.shop.catalogLimit.take(ip);
    return this.shop.catalog(code);
  }

  @Get('api/v1/shop/:code/articles/:id/thumb')
  async thumb(@Param('code') code: string, @Param('id') id: string, @Res() res: Response) {
    const t = await this.shop.thumb(code, id);
    if (!t) return res.status(404).end();
    res.setHeader('Content-Type', t.type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(t.data);
  }

  @Post('api/v1/shop/:code/orders')
  @HttpCode(200)
  order(@Param('code') code: string, @Body() body: unknown, @Ip() ip: string) {
    return this.shop.createOrder(code, body, ip);
  }

  // ——— Vérificateur de prix (public) ———

  @Get('prix/:code')
  async pricePage(@Param('code') code: string, @Res() res: Response) {
    const store = await this.shop.store(code);
    if (!store?.settings.priceChecker) {
      return html(res, 404, closedPage('Vérificateur de prix indisponible', store ? `Le vérificateur de prix n’est pas activé pour ${store.name}. Demandez le prix à un vendeur.` : 'Aucun magasin ne porte ce code. Vérifiez l’adresse de la page.'));
    }
    return html(res, 200, PRICE_PAGE);
  }

  @Get('api/v1/shop/:code/price-info')
  async priceInfo(@Param('code') code: string) {
    const store = await this.shop.priceStore(code);
    return { store: { name: store.name } };
  }

  @Get('api/v1/shop/:code/price')
  price(@Param('code') code: string, @Query('code') q: string | undefined, @Ip() ip: string) {
    this.shop.priceLimit.take(ip);
    return this.shop.price(code, q ?? '');
  }

  // ——— Postes du magasin ———

  /** Commandes de la boutique qui attendent un poste du magasin. */
  @Get('api/v1/web-orders')
  async webOrders(@Headers('authorization') auth: string | undefined) {
    return this.shop.waiting((await this.sync.authenticate(auth)).store_id);
  }

  @Post('api/v1/web-orders/:id/take')
  @HttpCode(200)
  async takeWebOrder(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.shop.take(await this.sync.authenticate(auth), id);
  }

  /** Sauvegarde chiffrée d'un PC (JSON, fichier en base64 : 200 Mo au plus). */
  @Post('api/v1/station-backups')
  @HttpCode(200)
  async uploadBackup(@Headers('authorization') auth: string | undefined, @Body() body: unknown) {
    return this.stationBackups.upload(await this.sync.authenticate(auth), body);
  }

  @Get('api/v1/station-backups')
  async listBackups(@Headers('authorization') auth: string | undefined) {
    return this.stationBackups.list((await this.sync.authenticate(auth)).store_id);
  }

  @Get('api/v1/station-backups/:id')
  async downloadBackup(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.stationBackups.download((await this.sync.authenticate(auth)).store_id, id);
  }

  // ——— Interface du serveur ———

  @Get('admin/api/web-orders')
  recent(@Req() req: Request) {
    if (!this.admin.isSession(cookieOf(req))) throw new UnauthorizedException('Connectez-vous');
    return this.shop.recent();
  }
}
