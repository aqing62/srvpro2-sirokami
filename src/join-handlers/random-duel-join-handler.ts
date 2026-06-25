import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RandomDuelProvider } from '../feats';

export class RandomDuelJoinHandler {
  private randomDuelProvider = this.ctx.get(() => RandomDuelProvider);

  constructor(private ctx: Context) {}

  async init() {
    if (!this.randomDuelProvider.enabled) {
      return;
    }
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      msg.pass = (msg.pass || '').trim();
      if (!msg.pass) {
        return next();
      }
      const type = this.randomDuelProvider.resolveRandomType(msg.pass);
      if (type == null) {
        return next();
      }
      const result = await this.randomDuelProvider.findOrCreateRandomRoom(
        type,
        client,
      );
      if (result.errorMessage) {
        return client.die(result.errorMessage, ChatColor.RED);
      }
      if (!result.room) {
        return client.die('#{create_room_failed}', ChatColor.RED);
      }
      return result.room.join(client);
    });
  }
}
