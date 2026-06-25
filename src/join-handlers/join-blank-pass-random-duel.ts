import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RandomDuelProvider } from '../feats';

export class JoinBlankPassRandomDuel {
  private randomDuelProvider = this.ctx.get(() => RandomDuelProvider);

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      msg.pass = (msg.pass || '').trim();
      if (msg.pass || !this.randomDuelProvider.enabled) {
        return next();
      }
      const result = await this.randomDuelProvider.findOrCreateRandomRoom(
        '',
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
