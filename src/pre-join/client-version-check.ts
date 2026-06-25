import {
  ChatColor,
  YGOProCtosJoinGame,
  YGOProStocErrorMsg,
} from 'ygopro-msg-encode';
import { Context } from '../app';

export class ClientVersionCheck {
  private altVersions = this.ctx.config.getIntArray('ALT_VERSIONS');

  version = this.ctx.config.getInt('YGOPRO_VERSION');

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(
      YGOProCtosJoinGame,
      async (msg, client, next) => {
        if (msg.version === this.version) {
          return next();
        }
        if (this.altVersions.includes(msg.version)) {
          await client.sendChat('#{version_polyfilled}', ChatColor.BABYBLUE);
          return next();
        }
        await client.sendChat('#{update_required}', ChatColor.RED);
        await client.send(
          new YGOProStocErrorMsg().fromPartial({
            msg: 4,
            code: this.version,
          }),
        );
        return client.disconnect();
      },
      true,
    );
  }
}
