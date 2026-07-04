import { ChatColor } from 'ygopro-msg-encode';
import * as fs from 'node:fs';
import { Context } from '../../app';
import { OnRoomWin, OnRoomGameStart, Room } from '../../room';
import { KoishiContextService } from '../../koishi/koishi-context-service';
import { PlayerRating } from './player-rating.entity';
import { DuelRecordEntity } from '../cloud-replay/duel-record.entity';
import { DuelRecordPlayer } from '../cloud-replay/duel-record-player.entity';
import { decodeDeckBase64 } from '../cloud-replay/utility';

const K_FACTOR = 32;

function loadCardMergeMap(): Record<number, number> {
  try {
    const raw = fs.readFileSync('./card_merge_map.json', 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export class LadderService {
  private koishiContextService = this.ctx.get(() => KoishiContextService);
  private cardMergeMap: Record<number, number> = {};

  constructor(private ctx: Context) {
    this.cardMergeMap = loadCardMergeMap();
  }

  async init() {
    // 房间阶段：双方已登录则广播天梯模式
    this.ctx.middleware(OnRoomGameStart, async (event, _client, next) => {
      await this.announceLadderMode(event.room);
      return next();
    });

    // 决斗结束：计算并记录 ELO
    this.ctx.middleware(OnRoomWin, async (event, _client, next) => {
      await this.processDuelResult(event.room, event.winMsg.player);
      return next();
    });

    // 启动时自动重算 ELO（基于 valid=true 的比赛记录）
    setTimeout(() => {
      this.recalculateAllRatings().catch((err) => {
        this.ctx.createLogger('LadderService').error('Auto recalculate failed: ' + err);
      });
    }, 5000);

    // /rating [玩家名] - 查看积分
    const koishi = this.koishiContextService.instance;
    this.koishiContextService
      .attachI18n('rating', { description: '查看天梯积分' });
    koishi.command('rating [...args]', '查看天梯积分').action(async ({ session }) => {
      const ctx = this.koishiContextService.resolveCommandContext(session);
      if (!ctx) return;
      const { client } = ctx;

      const args = (session.content || '').trim();
      const targetName = args.replace(/^\/rating[\s]*/i, '').trim()
        || client.displayName
        || client.accountName
        || '';

      if (!this.ctx.database) {
        await client.sendChat('数据库未启用', ChatColor.RED);
        return;
      }

      const repo = this.ctx.database.getRepository(PlayerRating);
      let rating: PlayerRating | null;

      // Try accountName first, then displayName
      rating = await repo.findOne({ where: { accountName: targetName } });
      if (!rating) {
        rating = await repo.findOne({ where: { displayName: targetName } });
      }

      if (!rating) {
        await client.sendChat(
          `玩家 "${targetName}" 暂无天梯数据`,
          ChatColor.YELLOW,
        );
        return;
      }

      await client.sendChat(
        [
          `=== ${rating.displayName || rating.accountName} ===`,
          `积分: ${rating.rating}  (胜${rating.wins} 负${rating.losses} 平${rating.draws})`,
          `胜率: ${rating.winRate}  总计: ${rating.totalDuels}场`,
          rating.winStreak > 1
            ? `连胜: ${rating.winStreak}场  最佳连胜: ${rating.bestStreak}场`
            : `最佳连胜: ${rating.bestStreak}场`,
        ].join('\n'),
        ChatColor.GREEN,
      );
    });

    // /ladder - 排行榜
    this.koishiContextService
      .attachI18n('ladder', { description: '查看天梯排行榜' });
    koishi.command('ladder', '查看天梯排行榜').action(async ({ session }) => {
      const ctx = this.koishiContextService.resolveCommandContext(session);
      if (!ctx) return;
      const { client } = ctx;

      if (!this.ctx.database) {
        await client.sendChat('数据库未启用', ChatColor.RED);
        return;
      }

      const repo = this.ctx.database.getRepository(PlayerRating);
      const top = await repo.find({
        order: { rating: 'DESC' },
        take: 10,
      });

      if (!top.length) {
        await client.sendChat('暂无天梯数据', ChatColor.YELLOW);
        return;
      }

      const lines = ['=== 天梯排行榜 TOP10 ==='];
      top.forEach((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const name = p.displayName || p.accountName;
        lines.push(`${medal} ${name} - ${p.rating}分 (${p.wins}胜${p.losses}负)`);
      });

      // Show requester's position if not in top 10
      const myName = client.accountName;
      if (myName && !top.find((p) => p.accountName === myName)) {
        const count = await repo.count();
        const myRating = await repo.findOne({ where: { accountName: myName } });
        if (myRating) {
          const above = await repo.count({
            where: {},
            order: { rating: 'DESC' },
          });
          // Count players with higher rating
          const higherCount = await repo
            .createQueryBuilder('p')
            .where('p.rating > :rating', { rating: myRating.rating })
            .getCount();
          lines.push(
            `...\n第${higherCount + 1}名: ${myRating.displayName || myRating.accountName} - ${myRating.rating}分`,
          );
        }
      }

      await client.sendChat(lines.join('\n'), ChatColor.GREEN);
    });

    // API: /api/ladder — 天梯排名（无需登录）
    this.ctx.router.get('/api/ladder', async (koaCtx) => {
      const database = this.ctx.database;
      if (!database) {
        koaCtx.body = { error: '数据库未启用' };
        return;
      }
      const repo = database.getRepository(PlayerRating);

      const search = String(koaCtx.query.search || '').trim();
      let players: PlayerRating[];

      if (search) {
        const player = await repo
          .createQueryBuilder('p')
          .where('p.accountName = :name', { name: search })
          .orWhere('p.displayName = :name2', { name2: search })
          .getOne();
        players = player ? [player] : [];
      } else {
        players = await repo.find({
          order: { rating: 'DESC' },
          take: 50,
        });
      }

      koaCtx.body = {
        players: players.map((p) => ({
          name: p.displayName || p.accountName,
          rating: p.rating,
          wins: p.wins,
          losses: p.losses,
          draws: p.draws,
          total: p.totalDuels,
          streak: p.winStreak,
          bestStreak: p.bestStreak,
          winRate: p.totalDuels > 0
            ? ((p.wins / p.totalDuels) * 100).toFixed(1) + '%'
            : '0%',
        })),
        total: players.length,
      };
    });

    // API: /api/ladder/decks — 天梯胜者卡组
    this.ctx.router.get('/api/ladder/decks', async (koaCtx) => {
      try {
      const database = this.ctx.database;
      if (!database) {
        koaCtx.body = { error: '数据库未启用' };
        return;
      }

      const player = String(koaCtx.query.player || '').trim();
      if (!player) {
        koaCtx.body = { error: '请提供 player 参数' };
        return;
      }

      const limit = Math.min(
        Math.max(parseInt(String(koaCtx.query.limit || '10'), 10) || 10, 1),
        50,
      );

      const recordRepo = database.getRepository(DuelRecordEntity);

      // 查询该玩家在天梯房中的胜局记录
      const records = await recordRepo
        .createQueryBuilder('record')
        .leftJoinAndSelect('record.players', 'player')
        .where('record.name LIKE :roomPattern', { roomPattern: 'M#%' })
        .andWhere('record.winReason IS NOT NULL')
        .andWhere('record.valid = true')
        .andWhere(
          'EXISTS (' +
            'SELECT 1 FROM duel_record_player winner ' +
            'WHERE winner."duelRecordId" = record.id ' +
            'AND winner.winner = true ' +
            'AND (winner.name = :playerName OR winner."realName" = :playerName2 OR winner.name LIKE :playerLike OR winner."realName" LIKE :playerLike2)' +
            'AND EXISTS (SELECT 1 FROM player_rating pr WHERE pr."accountName" = winner.name)' +
            ')',
          { playerName: player, playerName2: player, playerLike: player + '%', playerLike2: player + '%' },
        )
        .orderBy('record.endTime', 'DESC')
        .take(limit)
        .getMany();

      const decks = records.map((record) => {
        const winnerPlayer = record.players.find((p) => p.winner);
        const opponent = record.players.find((p) => !p.winner);
        const deck = winnerPlayer
          ? decodeDeckBase64(
              winnerPlayer.ingameDeckBuffer || winnerPlayer.currentDeckBuffer,
              winnerPlayer.ingameDeckMainc ?? winnerPlayer.currentDeckMainc ?? 0,
            )
          : null;

        return {
          replayId: Number(record.id),
          roomName: record.name,
          time: record.endTime,
          winner: winnerPlayer?.name || '',
          opponent: opponent?.name || '',
          score: winnerPlayer?.score || 0,
          deck: deck
            ? {
                main: deck.main || [],
                extra: deck.extra || [],
                side: deck.side || [],
              }
            : null,
        };
      });

      koaCtx.body = {
        player,
        total: decks.length,
        decks,
      };
      } catch (err) {
        koaCtx.status = 500;
        koaCtx.body = { error: (err as Error).message };
      }
    });

    // API: /api/ladder/card-stats — 卡片使用率/胜率统计
    this.ctx.router.get('/api/ladder/card-stats', async (koaCtx) => {
      try {
      const database = this.ctx.database;
      if (!database) {
        koaCtx.body = { error: '数据库未启用' };
        return;
      }

      const limit = Math.min(
        Math.max(parseInt(String(koaCtx.query.limit || '53'), 10) || 53, 1),
        100,
      );

      const recordRepo = database.getRepository(DuelRecordEntity);

      // 获取最近N场M#比赛房的已结束决斗
      const records = await recordRepo
        .createQueryBuilder('record')
        .leftJoinAndSelect('record.players', 'player')
        .where('record.name LIKE :roomPattern', { roomPattern: 'M#%' })
        .andWhere('record.winReason IS NOT NULL')
        .andWhere('record.valid = true')
        .orderBy('record.endTime', 'DESC')
        .take(500)
        .getMany();

      // 统计每张卡：出现在胜者卡组次数 / 出现在所有卡组次数
      const cardWins = new Map<number, number>();
      const cardTotal = new Map<number, number>();

      for (const record of records) {
        for (const player of record.players) {
          const deck = decodeDeckBase64(
            player.ingameDeckBuffer || player.currentDeckBuffer,
            player.ingameDeckMainc ?? player.currentDeckMainc ?? 0,
          );
          const allCards = [
            ...(deck.main || []),
            ...(deck.extra || []),
            ...(deck.side || []),
          ];
          // Remap alternate art cards to canonical ID
          const remapped = new Set<number>();
          for (const cid of allCards) {
            remapped.add(this.cardMergeMap[cid] || cid);
          }
          for (const cid of remapped) {
            cardTotal.set(cid, (cardTotal.get(cid) || 0) + 1);
            if (player.winner) {
              cardWins.set(cid, (cardWins.get(cid) || 0) + 1);
            }
          }
        }
      }

      const totalDecks = records.length * 2; // 每场2个卡组
      const MIN_TOTAL = 20;

      const cardList: Array<{ cardId: number; wins: number; total: number; winRate: number; usageRate: number }> = [];
      for (const [cid, total] of cardTotal) {
        const wins = cardWins.get(cid) || 0;
        cardList.push({
          cardId: cid,
          wins,
          total,
          winRate: total > 0 ? wins / total : 0,
          usageRate: totalDecks > 0 ? total / totalDecks : 0,
        });
      }

      const toResult = (c: typeof cardList[0]) => ({
        cardId: c.cardId,
        wins: c.wins,
        total: c.total,
        usageRate: (c.usageRate * 100).toFixed(1) + '%',
        winRate: (c.winRate * 100).toFixed(1) + '%',
      });

      const topUsed = [...cardList]
        .sort((a, b) => b.total - a.total || b.wins - a.wins)
        .slice(0, limit)
        .map(toResult);

      const topWinRate = [...cardList]
        .filter((c) => c.total >= MIN_TOTAL)
        .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins)
        .slice(0, limit)
        .map(toResult);

      koaCtx.body = {
        totalDuels: records.length,
        topUsed,
        topWinRate,
      };
      } catch (err) {
        koaCtx.status = 500;
        koaCtx.body = { error: (err as Error).message };
      }
    });

    // /winnerdeck [玩家名] - 查看天梯胜者卡组
    this.koishiContextService
      .attachI18n('winnerdeck', { description: '查看天梯胜者卡组' });
    koishi.command('winnerdeck [...args]', '查看天梯胜者卡组').action(async ({ session }) => {
      const ctx = this.koishiContextService.resolveCommandContext(session);
      if (!ctx) return;
      const { client } = ctx;

      const args = (session.content || '').trim();
      const targetName = args.replace(/^\/winnerdeck[\s]*/i, '').trim()
        || client.displayName
        || client.accountName
        || '';

      if (!this.ctx.database) {
        await client.sendChat('数据库未启用', ChatColor.RED);
        return;
      }

      const recordRepo = this.ctx.database.getRepository(DuelRecordEntity);

      const records = await recordRepo
        .createQueryBuilder('record')
        .leftJoinAndSelect('record.players', 'player')
        .where('record.name LIKE :roomPattern', { roomPattern: 'M#%' })
        .andWhere('record.winReason IS NOT NULL')
        .andWhere('record.valid = true')
        .andWhere(
          'EXISTS (' +
            'SELECT 1 FROM duel_record_player winner ' +
            'WHERE winner."duelRecordId" = record.id ' +
            'AND winner.winner = true ' +
            'AND (winner.name = :playerName OR winner."realName" = :playerName2 OR winner.name LIKE :playerLike OR winner."realName" LIKE :playerLike2)' +
            'AND EXISTS (SELECT 1 FROM player_rating pr WHERE pr."accountName" = winner.name)' +
            ')',
          { playerName: targetName, playerName2: targetName, playerLike: targetName + '%', playerLike2: targetName + '%' },
        )
        .orderBy('record.endTime', 'DESC')
        .take(3)
        .getMany();

      if (!records.length) {
        await client.sendChat(
          `玩家 "${targetName}" 暂未在天梯房获胜`,
          ChatColor.YELLOW,
        );
        return;
      }

      for (const record of records) {
        const winnerPlayer = record.players.find((p) => p.winner);
        const opponent = record.players.find((p) => !p.winner);
        const deck = winnerPlayer
          ? decodeDeckBase64(
              winnerPlayer.ingameDeckBuffer || winnerPlayer.currentDeckBuffer,
              winnerPlayer.ingameDeckMainc ?? winnerPlayer.currentDeckMainc ?? 0,
            )
          : null;

        const time = new Date(record.endTime);
        const timeStr = `${time.getMonth() + 1}/${time.getDate()} ${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`;
        const lines = [
          `=== ${winnerPlayer?.name || '?'} VS ${opponent?.name || '?'} (${timeStr}) ===`,
          deck
            ? `主卡组(${deck.main?.length || 0}): ${(deck.main || []).join(', ')}`
            : '',
          deck && deck.extra?.length
            ? `额外(${deck.extra.length}): ${deck.extra.join(', ')}`
            : '',
          deck && deck.side?.length
            ? `副卡组(${deck.side.length}): ${deck.side.join(', ')}`
            : '',
        ].filter(Boolean);

        await client.sendChat(lines.join('\n'), ChatColor.GREEN);
      }
    });

    // API: POST /api/ladder/recalculate — 重算所有天梯ELO积分
    this.ctx.router.post('/api/ladder/recalculate', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.pass || koaCtx.query.password || ''),
        'recalculate_rating',
        'recalculate_rating',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = { error: '权限不足' };
        return;
      }
      try {
        const result = await this.recalculateAllRatings();
        koaCtx.body = result;
      } catch (err) {
        koaCtx.status = 500;
        koaCtx.body = { error: (err as Error).message };
      }
    });
  }

  /**
   * Recalculate all ELO ratings from valid duel records.
   * Clears player_rating and replays all M# matches chronologically.
   */
  private async recalculateAllRatings(): Promise<{ processed: number; skipped: number; errors: number }> {
    const database = this.ctx.database;
    if (!database) throw new Error('数据库未启用');

    const duelRepo = database.getRepository(DuelRecordEntity);
    const ratingRepo = database.getRepository(PlayerRating);
    const logger = this.ctx.createLogger('RecalculateRatings');

    // Clear all existing ratings
    await ratingRepo.clear();
    logger.info('Cleared all player_rating records');

    // Get all valid M# room records chronologically
    const records = await duelRepo
      .createQueryBuilder('record')
      .leftJoinAndSelect('record.players', 'player')
      .where('record.name LIKE :pattern', { pattern: 'M#%' })
      .andWhere('record.winReason IS NOT NULL')
      .andWhere('record.valid = true')
      .orderBy('record.endTime', 'ASC')
      .getMany();

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const record of records) {
      try {
        // Skip tag mode
        if ((record.hostInfo.mode & 0x2) !== 0) {
          skipped++;
          continue;
        }

        // Find pos 0 and pos 1 players
        const p0 = record.players.find((p) => p.pos === 0);
        const p1 = record.players.find((p) => p.pos === 1);
        if (!p0 || !p1) {
          skipped++;
          continue;
        }

        // name = client.accountName for logged-in M# players
        const account0 = p0.name;
        const account1 = p1.name;

        // Determine result (same logic as processDuelResult)
        const winnerPlayer = record.players.find((p) => p.winner);
        if (!winnerPlayer) {
          skipped++; // draw or incomplete — skip for safety
          continue;
        }

        const isPosSwapped = !p0.isFirst;
        // winDuelPos = duel position of winner (0 or 1 for non-tag)
        const winDuelPos = winnerPlayer.pos & 0x1;
        const result = isPosSwapped
          ? (winDuelPos !== 0 ? 0 : 1)
          : (winDuelPos === 0 ? 0 : 1);
        // result: 0 = p0 wins, 1 = p1 wins

        // Get or create ratings
        let r0 = await ratingRepo.findOne({ where: { accountName: account0 } });
        let r1 = await ratingRepo.findOne({ where: { accountName: account1 } });

        if (!r0) {
          r0 = ratingRepo.create();
          r0.accountName = account0;
          r0.displayName = p0.realName;
        }
        if (!r1) {
          r1 = ratingRepo.create();
          r1.accountName = account1;
          r1.displayName = p1.realName;
        }

        // Keep display names fresh
        r0.displayName = p0.realName;
        r1.displayName = p1.realName;

        // ELO calculation (exact same as processDuelResult)
        const d0 = r1.rating - r0.rating;
        const e0 = 1 / (1 + Math.pow(10, d0 / 400));
        const e1 = 1 - e0;

        let s0: number, s1: number;
        if (result === 0) {
          s0 = 1; s1 = 0;
          r0.win(); r1.lose();
        } else {
          s0 = 0; s1 = 1;
          r0.lose(); r1.win();
        }

        const change0 = Math.round(K_FACTOR * (s0 - e0));
        const change1 = Math.round(K_FACTOR * (s1 - e1));

        r0.rating = Math.max(0, r0.rating + change0);
        r1.rating = Math.max(0, r1.rating + change1);

        await ratingRepo.save([r0, r1]);
        processed++;
      } catch (err) {
        logger.error(`Error processing record ${record.id}: ${err}`);
        errors++;
      }
    }

    logger.info(`Recalculate complete: ${processed} processed, ${skipped} skipped, ${errors} errors`);
    return { processed, skipped, errors };
  }

  private async processDuelResult(room: Room, winPlayer: number | undefined) {
    // 只在比赛房间计分
    if (!this.isMatchRoom(room)) return;
    if ((room.hostinfo.mode & 0x2) !== 0) return;

    const players = room.playingPlayers;
    if (players.length < 2) return;

    // 找到两个玩家
    const p0 = players.find((c) => c.pos === 0);
    const p1 = players.find((c) => c.pos === 1);
    if (!p0 || !p1) return;

    // 双方都必须登录
    if (!p0.loggedIn || !p1.loggedIn) return;

    // 排除 bot（名字以特殊标记或 isInternal）
    if (p0.isInternal || p1.isInternal) return;

    const database = this.ctx.database;
    if (!database) return;

    const repo = database.getRepository(PlayerRating);

    let r0 = await repo.findOne({ where: { accountName: p0.accountName! } });
    let r1 = await repo.findOne({ where: { accountName: p1.accountName! } });

    if (!r0) {
      r0 = repo.create();
      r0.accountName = p0.accountName!;
      r0.displayName = p0.displayName || p0.accountName!;
    }
    if (!r1) {
      r1 = repo.create();
      r1.accountName = p1.accountName!;
      r1.displayName = p1.displayName || p1.accountName!;
    }

    // Keep display names fresh
    r0.displayName = p0.displayName || p0.accountName!;
    r1.displayName = p1.displayName || p1.accountName!;

    // Determine result: 0 = p0 wins, 1 = p1 wins, -1 = draw
    const result =
      winPlayer === undefined ? -1
      : (room.isPosSwapped ? winPlayer !== 0 : winPlayer === 0) ? 0
      : 1;

    // Calculate ELO
    const d0 = r1.rating - r0.rating;
    const d1 = -d0;
    const e0 = 1 / (1 + Math.pow(10, d0 / 400));
    const e1 = 1 - e0;

    let s0: number, s1: number;
    if (result === -1) {
      s0 = 0.5; s1 = 0.5;
      r0.draw(); r1.draw();
    } else if (result === 0) {
      s0 = 1; s1 = 0;
      r0.win(); r1.lose();
    } else {
      s0 = 0; s1 = 1;
      r0.lose(); r1.win();
    }

    const change0 = Math.round(K_FACTOR * (s0 - e0));
    const change1 = Math.round(K_FACTOR * (s1 - e1));

    r0.rating = Math.max(0, r0.rating + change0);
    r1.rating = Math.max(0, r1.rating + change1);

    await repo.save([r0, r1]);
  }

  private isMatchRoom(room: Room): boolean {
    return room.name.startsWith('M#');
  }

  private async announceLadderMode(room: Room) {
    if (!this.isMatchRoom(room)) return;
    if ((room.hostinfo.mode & 0x2) !== 0) return;
    const players = room.playingPlayers;
    if (players.length < 2) return;
    const p0 = players.find((c) => c.pos === 0);
    const p1 = players.find((c) => c.pos === 1);
    if (!p0 || !p1) return;
    if (!p0.loggedIn || !p1.loggedIn) return;
    if (p0.isInternal || p1.isInternal) return;

    const name0 = p0.displayName || p0.accountName;
    const name1 = p1.displayName || p1.accountName;

    let r0 = 1000, r1 = 1000;
    const database = this.ctx.database;
    if (database) {
      const repo = database.getRepository(PlayerRating);
      const [rating0, rating1] = await Promise.all([
        repo.findOne({ where: { accountName: p0.accountName! } }),
        repo.findOne({ where: { accountName: p1.accountName! } }),
      ]);
      if (rating0) r0 = rating0.rating;
      if (rating1) r1 = rating1.rating;
    }

    await room.sendChat(
      `${name0}(${r0}) VS ${name1}(${r1}) — 双方已登录，本次决斗计入天梯积分`,
      ChatColor.GREEN,
    );
  }
}
