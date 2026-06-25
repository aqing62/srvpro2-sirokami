import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { CloudReplayService } from '../feats';

export class CloudReplayJoinHandler {
  private cloudReplayService = this.ctx.get(() => CloudReplayService);
  private enabled =
    this.ctx.config.getBoolean('ENABLE_CLOUD_REPLAY') && !!this.ctx.database;

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!this.enabled) {
        return next();
      }
      const pass = (msg.pass || '').trim();
      if (!pass) {
        return next();
      }
      if (await this.cloudReplayService.tryHandleJoinPass(pass, client)) {
        return;
      }
      return next();
    });
  }
}
