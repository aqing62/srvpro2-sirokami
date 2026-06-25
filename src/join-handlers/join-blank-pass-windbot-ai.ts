import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { JoinWindbotAi } from '../feats/windbot';

export class JoinBlankPassWindbotAi {
  private joinWindbotAi = this.ctx.get(() => JoinWindbotAi);

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      msg.pass = (msg.pass || '').trim();
      if (msg.pass) {
        return next();
      }
      if (await this.joinWindbotAi.joinByPass('AI', client)) {
        return;
      }
      return next();
    });
  }
}
