import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ADMIN_PAGE, MANAGER_ICON, MANAGER_PAGE } from './admin.page';
import { AdminService, LONG_SESSION_MS } from './admin.service';
import { ALERT_KINDS, AlertsService } from './alerts.service';
import { ApprovalsService } from './approvals.service';
import { BackupService } from './backup.service';
import { ManagerService } from './manager.service';
import { UpdatesService } from './updates.service';

const COOKIE = 'fedo_admin';

const cookieOf = (req: Request): string | undefined =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];

const isLocal = (req: Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

const setCookie = (res: Response, token: string, maxAgeMs = 12 * 3_600_000) =>
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(maxAgeMs / 1000)}`);

/** Le téléphone du gérant installe la page comme une application. */
const MANIFEST = {
  name: 'ONIX 360 Gérant',
  short_name: 'Gérant',
  description: 'Ventes du jour, caisses, écarts, ruptures et alertes de vos magasins',
  start_url: '/gerant',
  scope: '/gerant',
  display: 'standalone',
  background_color: '#f4f5f7',
  theme_color: '#1f7a4d',
  lang: 'fr',
  icons: [
    { src: '/gerant/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/gerant/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  ],
};

/** Service worker minimal : l'application s'installe et s'ouvre ; les chiffres viennent toujours du serveur. */
const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">Pas de connexion au serveur ONIX 360. Vérifiez le réseau puis rouvrez l’application.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
self.addEventListener('push', (e) => {
  const d = (() => { try { return e.data.json(); } catch { return { title: 'ONIX 360', body: e.data ? e.data.text() : '' }; } })();
  e.waitUntil(self.registration.showNotification(d.title || 'ONIX 360', { body: d.body || '', tag: d.tag, icon: '/gerant/icon.png', badge: '/gerant/icon.png', data: { url: d.url || '/gerant' }, renotify: true }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/gerant';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.includes('/gerant'));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
`;

/** Interface du serveur dans le navigateur (ou dans la fenêtre d’ONIX 360 Serveur). */
@Controller()
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(BackupService) private readonly backups: BackupService,
    @Inject(UpdatesService) private readonly updates: UpdatesService,
    @Inject(ManagerService) private readonly manager: ManagerService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
  ) {}

  private guard(req: Request) {
    if (!this.admin.isSession(cookieOf(req))) throw new UnauthorizedException('Connectez-vous');
  }

  @Get()
  page(@Query('t') t: string | undefined, @Res() res: Response) {
    if (t) {
      const token = this.admin.localLogin(t);
      if (token) setCookie(res, token);
      return res.redirect('/');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(ADMIN_PAGE);
  }

  // ——— Page du gérant (téléphone) ———

  @Get('gerant')
  managerPage(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(MANAGER_PAGE);
  }

  @Get('gerant/manifest.webmanifest')
  @Header('Content-Type', 'application/manifest+json; charset=utf-8')
  managerManifest() {
    return JSON.stringify(MANIFEST);
  }

  @Get('gerant/sw.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Service-Worker-Allowed', '/gerant')
  managerWorker() {
    return SERVICE_WORKER;
  }

  @Get('gerant/icon.png')
  managerIcon(@Res() res: Response) {
    const icon = MANAGER_ICON();
    if (!icon) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(icon);
  }

  @Get('admin/api/manager')
  managerDashboard(@Req() req: Request, @Query('day') day?: string) {
    this.guard(req);
    return this.manager.dashboard(day || undefined);
  }

  /** Demandes d'accord des caisses, en attente. */
  @Get('admin/api/approvals')
  pendingApprovals(@Req() req: Request) {
    this.guard(req);
    return this.approvals.pending();
  }

  @Post('admin/api/approvals/:id')
  @HttpCode(200)
  decideApproval(@Req() req: Request, @Param('id') id: string, @Body() body: { approve: boolean; pin?: string }) {
    this.guard(req);
    return this.approvals.decide(id, body);
  }

  /** Alertes nées depuis `since` (la page les montre avec un son). */
  @Get('admin/api/alerts')
  async phoneAlerts(@Req() req: Request, @Query('since') since?: string) {
    this.guard(req);
    const feed = await this.alerts.feed(since === undefined || since === '' ? undefined : Number(since));
    return { ...feed, kinds: ALERT_KINDS };
  }

  /** Clé publique des notifications ; elles ne marchent qu'avec un serveur en HTTPS. */
  @Get('admin/api/push/key')
  async pushKey(@Req() req: Request) {
    this.guard(req);
    return { publicKey: (await this.alerts.vapid()).publicKey };
  }

  @Post('admin/api/push/subscribe')
  @HttpCode(200)
  pushSubscribe(@Req() req: Request, @Body() body: Parameters<AlertsService['subscribe']>[0]) {
    this.guard(req);
    const origin = String(req.headers.origin ?? `${req.protocol}://${req.headers.host ?? ''}`);
    return this.alerts.subscribe(body, origin);
  }

  @Post('admin/api/push/unsubscribe')
  @HttpCode(200)
  pushUnsubscribe(@Req() req: Request, @Body() body: { endpoint: string }) {
    this.guard(req);
    return this.alerts.unsubscribe(body?.endpoint);
  }

  @Get('admin/api/session')
  async session(@Req() req: Request) {
    return { authenticated: this.admin.isSession(cookieOf(req)), hasPassword: await this.admin.hasPassword(), canChoose: this.admin.canChooseFirstPassword(isLocal(req)) };
  }

  @Post('admin/api/login')
  @HttpCode(200)
  async login(@Body() body: { password: string; remember?: boolean }, @Res({ passthrough: true }) res: Response) {
    const remember = body?.remember === true;
    setCookie(res, await this.admin.login(body?.password, remember), remember ? LONG_SESSION_MS : undefined);
    return { ok: true };
  }

  @Post('admin/api/first-password')
  @HttpCode(200)
  async firstPassword(@Body() body: { password: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    setCookie(res, await this.admin.firstPassword(body?.password, isLocal(req)));
    return { ok: true };
  }

  @Post('admin/api/logout')
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.admin.logout(cookieOf(req));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  }

  @Post('admin/api/password')
  @HttpCode(200)
  async password(@Req() req: Request, @Body() body: { password: string }) {
    this.guard(req);
    await this.admin.setPassword(body?.password);
    return { ok: true };
  }

  @Get('admin/api/overview')
  overview(@Req() req: Request) {
    this.guard(req);
    return this.admin.overview();
  }

  @Get('admin/api/groups')
  groups(@Req() req: Request) {
    this.guard(req);
    return this.admin.groups();
  }

  @Get('admin/api/events')
  events(@Req() req: Request, @Query('group') group?: string, @Query('store') store?: string, @Query('before') before?: string) {
    this.guard(req);
    return this.admin.events({ group: group || undefined, store: store || undefined, before: before ? Number(before) : undefined });
  }

  @Get('admin/api/sales')
  sales(@Req() req: Request) {
    this.guard(req);
    return this.admin.salesByDay();
  }

  @Post('admin/api/devices/:id/revoke')
  @HttpCode(200)
  async revoke(@Req() req: Request, @Param('id') id: string) {
    this.guard(req);
    await this.admin.revokeDevice(id);
    return { ok: true };
  }

  @Post('admin/api/enrollment-key')
  @HttpCode(200)
  renewKey(@Req() req: Request) {
    this.guard(req);
    return this.admin.renewEnrollmentKey();
  }

  @Get('admin/api/backups')
  listBackups(@Req() req: Request) {
    this.guard(req);
    return this.backups.list();
  }

  @Post('admin/api/backups')
  @HttpCode(200)
  backupNow(@Req() req: Request) {
    this.guard(req);
    return this.backups.backupNow();
  }

  @Post('admin/api/backups/settings')
  @HttpCode(200)
  async backupSettings(@Req() req: Request, @Body() body: { dir?: string; keep?: number }) {
    this.guard(req);
    await this.backups.configure(body ?? {});
    return { ok: true };
  }

  @Get('admin/api/backups/:name')
  @Header('Content-Type', 'application/gzip')
  async download(@Req() req: Request, @Param('name') name: string, @Res() res: Response) {
    this.guard(req);
    const data = await this.backups.file(name);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(data);
  }

  @Post('admin/api/backups/:name/restore')
  @HttpCode(200)
  async restore(@Req() req: Request, @Param('name') name: string) {
    this.guard(req);
    await this.backups.restore(name);
    return { ok: true };
  }

  @Get('admin/api/updates')
  updatesState(@Req() req: Request) {
    this.guard(req);
    return { dir: this.updates.dir(), current: this.updates.current() };
  }

  /** Dépôt d'un nouvel installateur : le fichier arrive tel quel (application/octet-stream). */
  @Post('admin/api/updates')
  @HttpCode(200)
  publishUpdate(@Req() req: Request, @Query('name') name: string) {
    this.guard(req);
    return this.updates.publish(name, req);
  }
}
