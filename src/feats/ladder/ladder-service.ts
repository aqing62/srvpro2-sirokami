import { ChatColor } from 'ygopro-msg-encode';
import * as fs from 'node:fs';
import { Context } from '../../app';
import { Client } from '../../client';
import { OnRoomWin, OnRoomGameStart, OnRoomPlayerReady, Room, DuelStage } from '../../room';
import { KoishiContextService } from '../../koishi/koishi-context-service';
import { PlayerRating } from './player-rating.entity';
import { DuelRecordEntity } from '../cloud-replay/duel-record.entity';
import { DuelRecordPlayer } from '../cloud-replay/duel-record-player.entity';
import { decodeDeckBase64 } from '../cloud-replay/utility';
import { User } from '../login/user.entity';

const WIN_POINTS = 10;               // 胜利基础分
const DRAW_POINTS = 3;               // 平局得分
const WIN_BONUS_MAX = 5;             // 对手分高时的额外加分上限
const MAX_SAME_OPPONENT_STREAK = 5;  // 同对手连胜上限，超过后不加分
const MIN_UNIQUE_OPPONENTS = 3;      // 排行榜最低对手多样性
const DIY_RATING = 150;              // DIY 投稿资格分数

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
    // 房间准备阶段：双方准备完毕且已登录则广播天梯模式
    this.ctx.middleware(OnRoomPlayerReady, async (event, _client, next) => {
      if (event.room.duelStage === DuelStage.Begin) {
        await this.announceLadderMode(event.room);
      }
      return next();
    });

    // 游戏开始阶段：双方已登录则广播天梯模式
    this.ctx.middleware(OnRoomGameStart, async (event, _client, next) => {
      await this.announceLadderMode(event.room);
      return next();
    });

    // 决斗结束：计算并记录 ELO
    this.ctx.middleware(OnRoomWin, async (event, _client, next) => {
      await this.processDuelResult(event.room, event.winMsg.player);
      return next();
    });

    // 启动时不再自动重算，改为手动调用 POST /api/ladder/recalculate

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

      // 查 User 表获取称号
      const userRepo = this.ctx.database.getRepository(User);
      const user = await userRepo.findOne({ where: { accountName: rating.accountName } });

      const lines = [
        `=== ${rating.displayName || rating.accountName} ===`,
      ];
      if (user?.ladderTitle || user?.title) {
        const badges = [user.ladderTitle, user.title].filter(Boolean).join(' · ');
        lines.push(`🏆 ${badges}`);
      }

      // 牢称号：天梯最后一名
      const lastPlace = await this.getLastPlacePlayer();
      if (lastPlace && lastPlace.accountName === rating.accountName) {
        lines.push('[牢] 天梯守门员！');
      }

      if (rating.probationGames > 0) {
        lines.push(
          `⚠️ 考察期剩余 ${rating.probationGames} 场（通过后进入排行榜）`,
        );
      }

      // 段位
      const cutoffs = await this.getTierCutoffs();
      const tierName = this.getTierName(rating.rating, rating.totalDuels, cutoffs);
      if (tierName) {
        lines.push(`段位: ${tierName}`);
      }

      lines.push(
        `积分: ${rating.rating}  (胜${rating.wins} 负${rating.losses} 平${rating.draws})`,
        `胜率: ${rating.winRate}  总计: ${rating.totalDuels}场`,
        rating.winStreak > 1
          ? `连胜: ${rating.winStreak}场  最佳连胜: ${rating.bestStreak}场`
          : `最佳连胜: ${rating.bestStreak}场`,
        `对手数: ${rating.uniqueOpponentCount}  (需${MIN_UNIQUE_OPPONENTS}名不同对手方可上榜)`,
      );
      await client.sendChat(lines.join('\n'), ChatColor.GREEN);
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
      // 先查足够多，再过滤考察期和对手多样性
      const all = await repo.find({
        order: { rating: 'DESC' },
        take: 50,
      });
      const top = all
        .filter((p) => p.probationGames <= 0 && p.uniqueOpponentCount >= MIN_UNIQUE_OPPONENTS)
        .slice(0, 10);

      if (!top.length) {
        await client.sendChat('暂无天梯数据', ChatColor.YELLOW);
        return;
      }

      const cutoffs = await this.getTierCutoffs();

      // 找最后一个合格玩家，标记"牢"
      const allEligible = all
        .filter((p) => p.probationGames <= 0 && p.uniqueOpponentCount >= MIN_UNIQUE_OPPONENTS);
      const lastPlaceName = allEligible.length > 0
        ? allEligible[allEligible.length - 1].accountName
        : null;

      const lines = ['=== 天梯排行榜 TOP10 ==='];
      top.forEach((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const name = p.displayName || p.accountName;
        const tier = this.getTierName(p.rating, p.totalDuels, cutoffs);
        const tierTag = tier ? `[${tier.replace('S1 ', '')}] ` : '';
        const lastTag = p.accountName === lastPlaceName ? ' [牢]' : '';
        lines.push(`${medal} ${tierTag}${name} - ${p.rating}分 (${p.wins}胜${p.losses}负)${lastTag}`);
      });

      // 段位门槛
      if (cutoffs.length) {
        lines.push('--- 段位门槛（活跃玩家百分比） ---');
        for (const tier of cutoffs) {
          lines.push(`${tier.name}: ≥${tier.minRating}分`);
        }
      }

      // Show requester's position if not in top 10
      const myName = client.accountName;
      if (myName && !top.find((p) => p.accountName === myName)) {
        const myRating = await repo.findOne({ where: { accountName: myName } });
        if (myRating) {
          // Count eligible players with higher rating
          const eligibleAbove = all
            .filter((p) => p.probationGames <= 0 && p.uniqueOpponentCount >= MIN_UNIQUE_OPPONENTS && p.rating > myRating.rating)
            .length;
          if (myRating.probationGames <= 0 && myRating.uniqueOpponentCount >= MIN_UNIQUE_OPPONENTS) {
            lines.push(
              `...\n第${eligibleAbove + 1}名: ${myRating.displayName || myRating.accountName} - ${myRating.rating}分`,
            );
          } else {
            lines.push(
              `...\n你暂未满足上榜条件（考察期剩余${myRating.probationGames}场 / 对手数${myRating.uniqueOpponentCount}/${MIN_UNIQUE_OPPONENTS}）`,
            );
          }
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
        const allPlayers = await repo.find({
          order: { rating: 'DESC' },
          take: 100,
        });
        players = allPlayers
          .filter((p) => p.probationGames <= 0 && p.uniqueOpponentCount >= MIN_UNIQUE_OPPONENTS)
          .slice(0, 50);
      }

      const cutoffs = await this.getTierCutoffs();

      // 找最后一个合格玩家
      const eligibleForLast = players.filter(Boolean);
      const lastPlaceAccount = eligibleForLast.length > 0
        ? eligibleForLast[eligibleForLast.length - 1].accountName
        : null;

      koaCtx.body = {
        players: players.map((p) => {
          const tier = this.getTierName(p.rating, p.totalDuels, cutoffs);
          return {
            name: p.displayName || p.accountName,
            rating: p.rating,
            wins: p.wins,
            losses: p.losses,
            draws: p.draws,
            total: p.totalDuels,
            streak: p.winStreak,
            bestStreak: p.bestStreak,
            tier: tier || null,
            winRate: p.totalDuels > 0
              ? ((p.wins / p.totalDuels) * 100).toFixed(1) + '%'
              : '0%',
            isLast: p.accountName === lastPlaceAccount,
          };
        }),
        total: players.length,
        tierCutoffs: cutoffs.map((t) => ({ name: t.name, minRating: t.minRating })),
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
        .where('(record.name LIKE :rp1 OR record.name LIKE :rp2)', { rp1: 'M#%', rp2: '%,RANDOM#%' })
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
        .where('(record.name LIKE :rp1 OR record.name LIKE :rp2)', { rp1: 'M#%', rp2: '%,RANDOM#%' })
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
      const MIN_TOTAL = 50;

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
        .where('(record.name LIKE :rp1 OR record.name LIKE :rp2)', { rp1: 'M#%', rp2: '%,RANDOM#%' })
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

    // POST /api/ladder/reset — 新赛季：清空积分 + 废弃全部录像
    this.ctx.router.post('/api/ladder/reset', async (koaCtx) => {
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
        const result = await this.resetSeason();
        koaCtx.body = result;
      } catch (err) {
        koaCtx.status = 500;
        koaCtx.body = { error: (err as Error).message };
      }
    });
  }

  /**
   * 新赛季重置：清空积分 + 废弃全部比赛记录
   */
  private async resetSeason(): Promise<{ ratingsCleared: number; recordsArchived: number }> {
    const database = this.ctx.database;
    if (!database) throw new Error('数据库未启用');

    const duelRepo = database.getRepository(DuelRecordEntity);
    const ratingRepo = database.getRepository(PlayerRating);
    const logger = this.ctx.createLogger('ResetSeason');

    // 清空积分
    const ratings = await ratingRepo.find();
    const ratingsCleared = ratings.length;
    await ratingRepo.clear();
    logger.info(`Cleared ${ratingsCleared} player_rating records`);

    // 废弃普通对局录像（保留比赛录像）
    const result = await duelRepo
      .createQueryBuilder()
      .update()
      .set({ valid: false })
      .where('valid = true')
      .andWhere('"isTournament" = false')
      .execute();
    const recordsArchived = result.affected || 0;
    logger.info(`Archived ${recordsArchived} duel records`);

    return { ratingsCleared, recordsArchived };
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

    // Load registered user accounts (must be logged in for ladder)
    const userRepo = database.getRepository(User);
    const loggedInAccounts = new Set(
      (await userRepo.find({ where: { enabled: true }, select: ['accountName'] }))
        .map((u) => u.accountName),
    );
    logger.info(`Loaded ${loggedInAccounts.size} registered users`);

    // Get all valid M# room records chronologically
    const records = await duelRepo
      .createQueryBuilder('record')
      .leftJoinAndSelect('record.players', 'player')
      .where('(record.name LIKE :rp1 OR record.name LIKE :rp2)', { rp1: 'M#%', rp2: '%,RANDOM#%' })
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

        // Both must be registered users (logged in) for ladder
        if (!loggedInAccounts.has(account0) || !loggedInAccounts.has(account1)) {
          skipped++;
          continue;
        }

        // realName with '$' means connected with password but didn't login
        if (p0.realName.includes('$') || p1.realName.includes('$')) {
          skipped++;
          continue;
        }

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

        // 纯正向积分计算（与 processDuelResult 一致）
        let points0: number;
        let points1: number;
        if (result === 0) {
          points0 = this.getWinPoints(r0, account1, r1.rating);
          points1 = 0;
          r0.win(); r1.lose();
        } else {
          points0 = 0;
          points1 = this.getWinPoints(r1, account0, r0.rating);
          r0.lose(); r1.win();
        }

        r0.rating = Math.max(0, r0.rating + points0);
        r1.rating = Math.max(0, r1.rating + points1);

        // 记录对手
        r0.addOpponent(account1);
        r1.addOpponent(account0);

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

    // 排除自己打自己
    if (p0.accountName === p1.accountName) return;

    // 排除同 IP
    if (p0.ip && p1.ip && p0.ip === p1.ip) return;

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

    // 计算得分（纯正向，输不掉分）
    const oldRating0 = r0.rating;
    const oldDuels0 = r0.totalDuels;
    const oldRating1 = r1.rating;
    const oldDuels1 = r1.totalDuels;

    let points0: number;
    let points1: number;
    if (result === -1) {
      points0 = DRAW_POINTS;
      points1 = DRAW_POINTS;
      r0.draw(); r1.draw();
    } else if (result === 0) {
      points0 = this.getWinPoints(r0, p1.accountName!, r1.rating);
      points1 = 0;
      r0.win(); r1.lose();
    } else {
      points0 = 0;
      points1 = this.getWinPoints(r1, p0.accountName!, r0.rating);
      r0.lose(); r1.win();
    }

    r0.rating = Math.max(0, r0.rating + points0);
    r1.rating = Math.max(0, r1.rating + points1);

    // 每日首胜 +2
    const dailyBonus = 2;
    const today = new Date().toDateString();
    if (result === 0 && r0.lastDuelAt?.toDateString() !== today) {
      r0.rating = Math.max(0, r0.rating + dailyBonus);
      await p0.sendChat('☀️ 每日首胜 +2！', ChatColor.YELLOW);
    } else if (result === 1 && r1.lastDuelAt?.toDateString() !== today) {
      r1.rating = Math.max(0, r1.rating + dailyBonus);
      await p1.sendChat('☀️ 每日首胜 +2！', ChatColor.YELLOW);
    }

    // 记录对手（双方各自记录）
    r0.addOpponent(p1.accountName!);
    r1.addOpponent(p0.accountName!);

    await repo.save([r0, r1]);

    // 检查段位升级 + DIY 投稿资格
    await this.checkTierUpgrade(
      r0, { rating: oldRating0, duels: oldDuels0 }, p0,
    );
    await this.checkTierUpgrade(
      r1, { rating: oldRating1, duels: oldDuels1 }, p1,
    );

    // 定级赛进度提示
    if (r0.probationGames > 0) {
      await p0.sendChat(
        `📋 定级赛进行中，还剩 ${r0.probationGames} 场即可上榜`,
        ChatColor.YELLOW,
      );
    }
    if (r1.probationGames > 0) {
      await p1.sendChat(
        `📋 定级赛进行中，还剩 ${r1.probationGames} 场即可上榜`,
        ChatColor.YELLOW,
      );
    }
  }

  // 段位百分比（从高到低），最后一项 pct=1.00 兜底
  private readonly TIER_PERCENTILES = [
    { name: 'S1 大师', pct: 0.08 },
    { name: 'S1 钻石', pct: 0.18 },
    { name: 'S1 黄金', pct: 0.35 },
    { name: 'S1 白银', pct: 0.60 },
    { name: 'S1 参战者', pct: 1.00 },
  ];

  /**
   * 获取当前各段位的分数线。
   * 活跃玩家 = 已通过定级赛 且 近7天有对局。
   */
  async getTierCutoffs(): Promise<{ name: string; minRating: number }[]> {
    const database = this.ctx.database;
    if (!database) return [];

    const repo = database.getRepository(PlayerRating);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const active = await repo
      .createQueryBuilder('p')
      .where('p.probationGames <= 0')
      .andWhere('p.lastDuelAt >= :since', { since: sevenDaysAgo })
      .orderBy('p.rating', 'DESC')
      .getMany();

    if (!active.length) return [];

    return this.TIER_PERCENTILES.map((tier) => {
      const idx = Math.max(0, Math.ceil(active.length * tier.pct) - 1);
      return { name: tier.name, minRating: active[idx]?.rating ?? 0 };
    });
  }

  /**
   * 根据分数和场次判断当前段位名，不满足条件返回 null。
   */
  getTierName(
    rating: number,
    _duels: number,
    cutoffs: { name: string; minRating: number }[],
  ): string | null {
    if (!cutoffs.length) return null;
    for (const tier of cutoffs) {
      if (rating >= tier.minRating) return tier.name;
    }
    return null;
  }

  /**
   * 获取天梯最后一名（牢称号），从活跃合格玩家中取最低分。
   */
  private async getLastPlacePlayer(): Promise<PlayerRating | null> {
    const database = this.ctx.database;
    if (!database) return null;

    const repo = database.getRepository(PlayerRating);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    return (
      (await repo
        .createQueryBuilder('p')
        .where('p.probationGames <= 0')
        .andWhere('p.uniqueOpponentCount >= :minOpp', { minOpp: MIN_UNIQUE_OPPONENTS })
        .andWhere('p.lastDuelAt >= :since', { since: sevenDaysAgo })
        .orderBy('p.rating', 'ASC')
        .take(1)
        .getOne()) || null
    );
  }

  /** 段位索引越小越强，用于判断晋升方向 */
  private getTierIndex(tierName: string | null): number {
    if (!tierName) return this.TIER_PERCENTILES.length;
    const idx = this.TIER_PERCENTILES.findIndex((t) => t.name === tierName);
    return idx >= 0 ? idx : this.TIER_PERCENTILES.length;
  }

  private async checkTierUpgrade(
    rating: PlayerRating,
    old: { rating: number; duels: number },
    client: Client,
  ) {
    const cutoffs = await this.getTierCutoffs();
    if (!cutoffs.length) return;

    const newTier = this.getTierName(rating.rating, rating.totalDuels, cutoffs);
    const oldTier = this.getTierName(old.rating, old.duels, cutoffs);

    // 段位晋升提示（仅上分 + 真正升段时播报）
    const gained = rating.rating > old.rating;
    const upgraded = this.getTierIndex(newTier) < this.getTierIndex(oldTier);
    if (gained && upgraded && newTier) {
      await client.sendChat(
        `🎉 恭喜！你已达成「${newTier}」段位！`,
        ChatColor.YELLOW,
      );
    }

    // DIY 投稿资格提示（积分 ≥150）
    if (old.rating < DIY_RATING && rating.rating >= DIY_RATING) {
      await client.sendChat(
        '📝 你已获得 DIY 投稿资格（积分≥150），联系群主提交卡稿吧！',
        ChatColor.YELLOW,
      );
    }
  }

  private isMatchRoom(room: Room): boolean {
    return !!(room as any).randomType || room.name.startsWith('M#');
  }

  /**
   * 计算胜者得分：基础分 + 对手分高奖励（上限 WIN_BONUS_MAX）。
   * 同一对手连胜超过 MAX_SAME_OPPONENT_STREAK 场后返回 0，不再加分。
   */
  private getWinPoints(winner: PlayerRating, loserAccount: string, loserRating: number): number {
    if (winner.lastOpponent === loserAccount) {
      winner.sameOpponentStreak++;
    } else {
      winner.lastOpponent = loserAccount;
      winner.sameOpponentStreak = 1;
    }
    if (winner.sameOpponentStreak > MAX_SAME_OPPONENT_STREAK) {
      return 0;
    }
    const bonus = Math.max(0, Math.min(
      Math.floor((loserRating - winner.rating) / 100),
      WIN_BONUS_MAX,
    ));
    return WIN_POINTS + bonus;
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

    let r0 = 0, r1 = 0;
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
