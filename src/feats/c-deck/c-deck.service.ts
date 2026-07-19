import * as fs from 'node:fs';
import * as path from 'node:path';
import YGOProDeck from 'ygopro-deck-encode';
import { YGOProStocChangeSide } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { OnRoomJoinPlayer } from '../../room/room-event/on-room-join-player';
import { DuelStage } from '../../room/duel-stage';

const DECKS_DIR = './decks-c/';

export class CDeckService {
  private decks: YGOProDeck[] = [];

  constructor(private ctx: Context) {}

  private get logger() {
    return this.ctx.createLogger('CDeckService');
  }

  async init() {
    this.loadDecks();

    // 玩家加入 C 模式房间时，自动分配随机卡组
    this.ctx.middleware(OnRoomJoinPlayer, async (event, client, next) => {
      const room = event.room;
      if (!room.hostinfo.random_deck) return next();
      if (client.deck) return next(); // 已有卡组，不重复分配
      if (room.duelStage !== DuelStage.Begin) return next();

      // C 模式强制 noHost
      room.noHost = true;

      const assigned = this.assignRandomDeck(room);
      if (!assigned) {
        await room.sendChat('卡组池为空，请联系管理员上传卡组');
        return next();
      }

      client.deck = assigned;
      client.startDeck = assigned;

      // 通知所有人该玩家已准备
      const changeMsg = client.prepareChangePacket();
      await Promise.all(
        room.allPlayers.map((p) => p.send(changeMsg)),
      );

      this.logger.info(
        `${client.name} assigned random deck "${assigned.name}" in room ${room.name}`,
      );

      // 双方到齐 → 进入备牌阶段，不直接开打
      const allReadyAndFull = room.playingPlayers.length === room.players.length
        && room.playingPlayers.every((p) => p.deck);
      if (allReadyAndFull) {
        room.duelStage = DuelStage.Siding;
        // 清除 deck 让客户端进入备牌 UI（startDeck 保留用于校验）
        for (const p of room.playingPlayers) {
          p.deck = undefined;
        }
        await Promise.all(
          room.playingPlayers.map((p) =>
            p.send(new YGOProStocChangeSide()),
          ),
        );
        await room.sendChat(
          '双方已获得随机卡组，请在 90 秒内调整备牌后提交',
        );
      }

      return next();
    });
  }

  private loadDecks() {
    try {
      if (!fs.existsSync(DECKS_DIR)) {
        fs.mkdirSync(DECKS_DIR, { recursive: true });
        this.logger.warn(`Created empty ${DECKS_DIR} directory`);
        return;
      }
      const files = fs.readdirSync(DECKS_DIR).filter((f) => f.endsWith('.ydk'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(DECKS_DIR, file), 'utf-8');
          const deck = YGOProDeck.fromYdkString(content);
          deck.name = file.replace('.ydk', '');
          this.decks.push(deck);
        } catch (err) {
          this.logger.warn(`Failed to load deck ${file}: ${err}`);
        }
      }
      this.logger.info(`Loaded ${this.decks.length} decks from ${DECKS_DIR}`);
    } catch (err) {
      this.logger.error(`Failed to load decks from ${DECKS_DIR}: ${err}`);
    }
  }

  /**
   * 给房间玩家分配一个随机卡组，确保同一房间内不重复。
   */
  private assignRandomDeck(room: { playingPlayers: Array<{ deck?: YGOProDeck }> }): YGOProDeck | null {
    if (!this.decks.length) return null;

    const usedDecks = new Set(
      room.playingPlayers
        .filter((p) => p.deck)
        .map((p) => p.deck!.name),
    );

    const available = this.decks.filter((d) => !usedDecks.has(d.name));
    const pool = available.length > 0 ? available : this.decks;
    return pool[Math.floor(Math.random() * pool.length)];
  }
}
