import * as fs from 'node:fs';
import * as path from 'node:path';
import YGOProDeck from 'ygopro-deck-encode';
import { Context } from '../../app';
import { OnRoomPlayerReady } from '../../room/room-event/on-room-player-ready';
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

    // C 模式：玩家准备后替换为随机卡组
    this.ctx.middleware(OnRoomPlayerReady, async (event, client, next) => {
      const room = event.room;
      if (!room.hostinfo.random_deck) return next();
      if (room.duelStage !== DuelStage.Begin) return next();

      // 分配随机卡组（替换客户端提交的卡组）
      const assigned = this.assignRandomDeck(room);
      if (!assigned) {
        await room.sendChat('卡组池为空，请联系管理员上传卡组');
        return next();
      }

      client.deck = assigned;
      client.startDeck = assigned;

      this.logger.info(`${client.name} assigned deck "${assigned.name}" in room ${room.name}`);

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
