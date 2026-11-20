import * as fs from 'node:fs';
import * as path from 'node:path';
import YGOProDeck from 'ygopro-deck-encode';
import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { OnRoomPlayerReady } from '../../room/room-event/on-room-player-ready';
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

    // ── C 模式（编年史）：进房即分配随机卡组并告知，准备时只采纳玩家的备牌 ──
    // 这样「猜拳之前」玩家就知道自己是先攻还是后攻卡组，可以先调好备牌再准备。
    this.ctx.middleware(OnRoomJoinPlayer, async (event, client, next) => {
      const room = event.room;
      if (room.hostinfo.random_deck && room.duelStage === DuelStage.Begin && client.pos <= 1) {
        await this.assignForClient(room, client);
      }
      return next();
    });

    this.ctx.middleware(OnRoomPlayerReady, async (event, client, next) => {
      const room = event.room;
      if (!room.hostinfo.random_deck) return next();
      if (room.duelStage !== DuelStage.Begin) return next();

      // 首次准备时如果还没分配（比如加入时机早于进房事件），这里补一次
      let assigned = (client as any).__cAssignedDeck as YGOProDeck | undefined;
      if (!assigned) {
        assigned = await this.assignForClient(room, client);
        if (!assigned) return next();
      }

      // 主卡组/额外卡组沿用分配的随机卡组，备牌用玩家提交的（没交就沿用卡池备牌）
      const submitted = client.deck;
      const side =
        submitted && Array.isArray(submitted.side) && submitted.side.length
          ? submitted.side
          : assigned.side;
      const finalDeck = new YGOProDeck({
        main: [...assigned.main],
        extra: [...assigned.extra],
        side: [...side],
        name: assigned.name,
      });
      client.deck = finalDeck;
      client.startDeck = finalDeck;
      this.logger.info(
        `${client.name} ready with deck "${assigned.name}" (side ${side.length}) in room ${room.name}`,
      );
      return next();
    });
  }

  /** 给玩家分配一套随机卡组（记在 client 上）并在聊天里告知 */
  private async assignForClient(
    room: { playingPlayers: Array<{ deck?: YGOProDeck }>; name: string; sendChat: (m: string) => Promise<unknown> },
    client: { name?: string; __cAssignedDeck?: YGOProDeck; sendChat: (m: string, t?: number) => Promise<unknown> },
  ): Promise<YGOProDeck | undefined> {
    const random = this.assignRandomDeck(room as any);
    if (!random) {
      await room.sendChat('卡组池为空，请联系管理员上传卡组');
      return undefined;
    }
    const deck = new YGOProDeck({
      main: [...random.main],
      extra: [...random.extra],
      side: [...random.side],
      name: random.name,
    });
    client.__cAssignedDeck = deck;
    this.logger.info(`${client.name} assigned deck "${random.name}" in room ${room.name}`);
    await client.sendChat(`🎴 本局你的随机卡组：${random.name}`, ChatColor.YELLOW);
    await client.sendChat(
      '📝 备牌阶段：先在官网「编年史卡组池」确认这套是先攻/后攻卡组，调好备牌后再点准备；准备时主卡组与额外卡组由系统指定，只采纳你的备牌。',
      ChatColor.BABYBLUE,
    );
    return deck;
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
