import * as fs from 'node:fs';
import * as path from 'node:path';
import YGOProDeck from 'ygopro-deck-encode';
import { ChatColor, YGOProStocChangeSide } from 'ygopro-msg-encode';
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

    this.ctx.middleware(OnRoomJoinPlayer, async (event, client, next) => {
      const room = event.room;
      if (!room.hostinfo.random_deck) return next();
      if (room.duelStage !== DuelStage.Begin) return next();

      room.noHost = true;

      // 分配随机卡组
      const assigned = this.assignRandomDeck(room);
      if (assigned) {
        client.deck = assigned;
        client.startDeck = assigned;
        this.logger.info(`${client.name} assigned deck "${assigned.name}" in room ${room.name}`);
        await client.sendChat(
          `编年史模式：你获得了随机卡组「${assigned.name}」`,
          ChatColor.BABYBLUE,
        );
      }

      // 通知所有玩家
      const changeMsg = client.prepareChangePacket();
      await Promise.all(
        room.allPlayers.map((p) => p.send(changeMsg)),
      );

      // 双方到齐 → 进入备牌阶段
      const allReady = room.playingPlayers.length === room.players.length
        && room.playingPlayers.every((p) => p.deck);
      if (allReady && room.duelStage === DuelStage.Begin) {
        room.duelStage = DuelStage.Siding;
        for (const p of room.playingPlayers) {
          p.startDeck = p.deck; // 保留分配的卡组作为基准
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
