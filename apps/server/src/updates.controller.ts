import { Controller, Get, Param, Res } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Response } from 'express';
import { UpdatesService } from './updates.service';

/** Fichiers lus par la mise à jour automatique des PC (sans mot de passe). */
@Controller('mises-a-jour')
export class UpdatesController {
  constructor(@Inject(UpdatesService) private readonly updates: UpdatesService) {}

  @Get(':name')
  file(@Param('name') name: string, @Res() res: Response) {
    const path = this.updates.file(name);
    if (name === 'latest.yml') res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path);
  }
}
