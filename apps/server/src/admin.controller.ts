import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ADMIN_PAGE } from './admin.page';
import { AdminService } from './admin.service';
import { BackupService } from './backup.service';
import { UpdatesService } from './updates.service';

const COOKIE = 'fedo_admin';

const cookieOf = (req: Request): string | undefined =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];

const isLocal = (req: Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

const setCookie = (res: Response, token: string) =>
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);

/** Interface du serveur dans le navigateur (ou dans la fenêtre de FEDONIX 360 Serveur). */
@Controller()
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(BackupService) private readonly backups: BackupService,
    @Inject(UpdatesService) private readonly updates: UpdatesService,
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

  @Get('admin/api/session')
  async session(@Req() req: Request) {
    return { authenticated: this.admin.isSession(cookieOf(req)), hasPassword: await this.admin.hasPassword(), canChoose: this.admin.canChooseFirstPassword(isLocal(req)) };
  }

  @Post('admin/api/login')
  @HttpCode(200)
  async login(@Body() body: { password: string }, @Res({ passthrough: true }) res: Response) {
    setCookie(res, await this.admin.login(body?.password));
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
