import {
  ChatColor,
  YGOProMsgDamage,
  YGOProMsgPayLpCost,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { RoomManager } from '../room';

export class LpLowHintService {
  private roomManager = this.ctx.get(() => RoomManager);

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProMsgDamage, async (msg, client, next) => {
      await this.trySendLowLpHint(msg.player, client, '#{lp_low_opponent}');
      return next();
    });

    this.ctx.middleware(YGOProMsgPayLpCost, async (msg, client, next) => {
      await this.trySendLowLpHint(msg.player, client, '#{lp_low_self}');
      return next();
    });
  }

  private async trySendLowLpHint(
    playerPos: number,
    client: Client,
    hintText: string,
  ) {
    const room = this.resolveRoom(client);
    if (!room) {
      return;
    }

    const fieldInfo = await room.getCurrentFieldInfo();
    if (!fieldInfo?.length) {
      return;
    }

    if (
      !Number.isInteger(playerPos) ||
      playerPos < 0 ||
      playerPos >= fieldInfo.length
    ) {
      return;
    }

    const lp = fieldInfo[playerPos]?.lp;
    if (typeof lp !== 'number' || lp <= 0 || lp > 100) {
      return;
    }

    await room.sendChat(hintText, ChatColor.PINK);
  }

  private resolveRoom(client: Client) {
    if (!client.roomName) {
      return undefined;
    }
    const room = this.roomManager.findByName(client.roomName);
    if (!room || room.finalizing) {
      return undefined;
    }
    return room;
  }
}
