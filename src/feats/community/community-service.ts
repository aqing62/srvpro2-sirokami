import type { DataSource } from 'typeorm';
import type Router from '@koa/router';
import { CommunityPostEntity } from './community-post.entity';
import { CommunityReplyEntity } from './community-reply.entity';
import { CommunityLikeEntity } from './community-like.entity';
import { CommunityUserProfileEntity } from './community-user-profile.entity';
import { User } from '../login';
import { In } from 'typeorm';
import { DuelRecordEntity } from '../cloud-replay/duel-record.entity';
import { DuelRecordPlayer } from '../cloud-replay/duel-record-player.entity';
import { PlayerRating } from '../ladder';

interface Ctx {
  database?: DataSource;
  router: Router;
}

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;
const MAX_REPLY = 500;
const MAX_PAGE_SIZE = 30;
const BODY_MAX = 1_000_000;

export class CommunityService {
  constructor(private ctx: Ctx) {}

  async init() {
    const db = () => this.ctx.database;

    // ═══════════════════════════════════════════
    // 工具函数
    // ═══════════════════════════════════════════

    const readBody = (koaCtx: any): Promise<string> =>
      new Promise((resolve, reject) => {
        let data = '';
        koaCtx.req.on('data', (chunk: string) => {
          data += chunk;
          if (data.length > BODY_MAX) koaCtx.req.destroy(new Error('body too large'));
        });
        koaCtx.req.on('end', () => resolve(data));
        koaCtx.req.on('error', reject);
      });

    const requireAuth = async (koaCtx: any): Promise<string | null> => {
      const database = db();
      if (!database) return null;
      const username = String(koaCtx.query.username || '').trim();
      const pass = String(koaCtx.query.pass || koaCtx.query.password || '').trim();
      if (!username || !pass) return null;
      const repo = database.getRepository(User);
      const user = await repo.findOneBy({ accountName: username } as any);
      if (!user || user.enabled === false || user.password !== pass) return null;
      return user.accountName;
    };

    const requireAuthFromBody = async (koaCtx: any, body: any): Promise<string | null> => {
      const database = db();
      if (!database) return null;
      const username = String(body.username || '').trim();
      const pass = String(body.password || '').trim();
      if (!username || !pass) return null;
      const repo = database.getRepository(User);
      const user = await repo.findOneBy({ accountName: username } as any);
      if (!user || user.enabled === false || user.password !== pass) return null;
      return user.accountName;
    };

    const auth403 = (koaCtx: any) => {
      koaCtx.status = 403;
      koaCtx.body = { error: '未登录或账号密码错误' };
    };

    const getPage = (koaCtx: any, def = 1) =>
      Math.max(1, parseInt(String(koaCtx.query.page), 10) || def);

    const getPageSize = (koaCtx: any, def = 12) =>
      Math.min(Math.max(1, parseInt(String(koaCtx.query.pageSize), 10) || def), MAX_PAGE_SIZE);

    // ═══════════════════════════════════════════
    // POST /api/forum/verify — 验证登录
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/verify', async (koaCtx) => {
      const body = JSON.parse(await readBody(koaCtx));
      const accountName = await requireAuthFromBody(koaCtx, body);
      if (!accountName) {
        auth403(koaCtx);
        return;
      }
      koaCtx.body = { ok: true, accountName };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/profile
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/profile', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const database = db()!;
      const profileRepo = database.getRepository(CommunityUserProfileEntity);
      let profile = await profileRepo.findOneBy({ accountName } as any);
      if (!profile) {
        profile = new CommunityUserProfileEntity();
        profile.accountName = accountName;
        const userRepo = database.getRepository(User);
        const user = await userRepo.findOneBy({ accountName } as any);
        if (user?.displayName) profile.displayName = user.displayName;
        await profileRepo.save(profile);
      }
      koaCtx.body = {
        accountName: profile.accountName,
        displayName: profile.displayName || accountName,
        avatarVersion: profile.avatarVersion,
        avatarUpdatedAt: profile.avatarUpdatedAt,
        nameUpdatedAt: profile.nameUpdatedAt,
        // 是否今天已修改
        canChangeAvatar: !isSameDay(profile.avatarUpdatedAt),
        canChangeName: !isSameDay(profile.nameUpdatedAt),
      };
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/profile/display-name
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/profile/display-name', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const body = JSON.parse(await readBody(koaCtx));
      const newName = String(body.displayName || '').trim().slice(0, 64);
      if (!newName) { koaCtx.body = { error: '显示名不能为空' }; return; }

      const database = db()!;
      const profileRepo = database.getRepository(CommunityUserProfileEntity);
      let profile = await profileRepo.findOneBy({ accountName } as any);
      if (!profile) {
        profile = new CommunityUserProfileEntity();
        profile.accountName = accountName;
      }
      if (isSameDay(profile.nameUpdatedAt)) {
        koaCtx.body = { error: '今天已修改过显示名，请明天再试' };
        return;
      }

      profile.displayName = newName;
      profile.nameUpdatedAt = new Date();
      await profileRepo.save(profile);

      // 同步 srv_user
      const userRepo = database.getRepository(User);
      const user = await userRepo.findOneBy({ accountName } as any);
      if (user) {
        user.displayName = newName;
        await userRepo.save(user);
      }

      koaCtx.body = { ok: true, displayName: newName, canChangeName: false };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/profile/titles — 我的称号列表与当前选择
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/profile/titles', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const database = db()!;
      const userRepo = database.getRepository(User);
      const user = await userRepo.findOneBy({ accountName } as any);
      // 统一称号池：赛季称号 + 管理员/比赛称号（title 字段）合并去重
      let titles: string[] = [];
      try {
        const parsed = JSON.parse(user?.titles || '[]');
        if (Array.isArray(parsed)) titles = parsed;
      } catch {
        /* 忽略格式错误的旧数据 */
      }
      const adminTitle = (user?.title || '').trim();
      if (adminTitle && !titles.includes(adminTitle)) titles.push(adminTitle);
      koaCtx.body = {
        titles,
        adminTitle,
        selectedTitle: user?.selectedTitle || '',
        selectedTitle2: user?.selectedTitle2 || '',
      };
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/profile/title — 保存称号选择（主+副）
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/profile/title', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const body = JSON.parse(await readBody(koaCtx));
      const selectedTitle = String(body.selectedTitle || '').trim().slice(0, 64);
      const selectedTitle2 = String(body.selectedTitle2 || '').trim().slice(0, 64);
      if (selectedTitle && selectedTitle === selectedTitle2) {
        koaCtx.body = { error: '主称号与副称号不能相同' };
        return;
      }
      const database = db()!;
      const userRepo = database.getRepository(User);
      const user = await userRepo.findOneBy({ accountName } as any);
      // 统一称号池（与 GET 一致）：赛季称号 + 管理员/比赛称号
      let titles: string[] = [];
      try {
        const parsed = JSON.parse(user?.titles || '[]');
        if (Array.isArray(parsed)) titles = parsed;
      } catch {
        /* 忽略格式错误的旧数据 */
      }
      const adminTitle = (user?.title || '').trim();
      if (adminTitle && !titles.includes(adminTitle)) titles.push(adminTitle);
      const valid = (t: string) => !t || titles.includes(t);
      if (!valid(selectedTitle) || !valid(selectedTitle2)) {
        koaCtx.body = { error: '所选称号不在你的称号列表里' };
        return;
      }
      await userRepo.update({ accountName }, { selectedTitle, selectedTitle2 } as any);
      koaCtx.body = { ok: true, selectedTitle, selectedTitle2 };
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/profile/password — 修改登录密码
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/profile/password', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const body = JSON.parse(await readBody(koaCtx));
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || body.password || '');
      const database = db()!;
      const userRepo = database.getRepository(User);
      const user = await userRepo.findOneBy({ accountName } as any);
      if (!user || user.password !== oldPassword) {
        koaCtx.body = { error: '当前密码不正确' };
        return;
      }
      if (newPassword.length < 6) {
        koaCtx.body = { error: '新密码至少 6 位' };
        return;
      }
      await userRepo.update({ accountName }, { password: newPassword } as any);
      koaCtx.body = { ok: true };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/profile/duels — 我的最近对局记录（时间/房间/对手/回放码 R#id）
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/profile/duels', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const database = db()!;
      const duelRepo = database.getRepository(DuelRecordEntity);

      // 注册账号集合（用于判断对局双方是否都已登录 —— 天梯积分触发条件之一）
      const userRepo = database.getRepository(User);
      const users = await userRepo.find({ select: ['accountName'] as any });
      const registered = new Set(users.map((u) => u.accountName));

      const records = await duelRepo
        .createQueryBuilder('record')
        .innerJoinAndSelect('record.players', 'players')
        .where('record.valid = true')
        .andWhere('record."winReason" IS NOT NULL')
        .andWhere(
          'EXISTS (SELECT 1 FROM duel_record_player me WHERE me."duelRecordId" = record.id AND me.name = :name)',
          { name: accountName },
        )
        .orderBy('record.endTime', 'DESC')
        .take(30)
        .getMany();

      const duels = records.map((record) => {
        const me = (record.players || []).find((p) => p.name === accountName);
        const opponent = (record.players || []).find((p) => p !== me);
        const roomName = record.name || '';
        // 天梯积分触发判定：M# 或随机天梯房 + 非双打 + 双方都是注册账号（且非同一人）
        const isLadderRoom =
          roomName.startsWith('M#') || roomName.indexOf(',RANDOM#') !== -1;
        const notTag = !(record.hostInfo && (record.hostInfo.mode & 0x2) !== 0);
        const players = record.players || [];
        const allRegistered =
          players.length >= 2 && players.every((p) => registered.has(p.name));
        const distinctPlayers = new Set(players.map((p) => p.name)).size === players.length;
        return {
          time: record.endTime,
          roomName,
          selfName: (me && (me.realName || me.name)) || accountName,
          opponentName: (opponent && (opponent.realName || opponent.name)) || '',
          replayCode: 'R#' + record.id,
          ladder: !!(isLadderRoom && notTag && allRegistered && distinctPlayers),
        };
      });

      koaCtx.body = { duels };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/profile/ladder — 当前赛季天梯排名与段位
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/profile/ladder', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const database = db()!;
      const ratingRepo = database.getRepository(PlayerRating);

      // 段位分档（与 ladder-service TIER_PERCENTILES 保持一致，换赛季时同步更新）
      const tierDefs = [
        { name: 'S2 巅峰', pct: 0 },
        { name: 'S2 大师', pct: 0.08 },
        { name: 'S2 钻石', pct: 0.18 },
        { name: 'S2 黄金', pct: 0.35 },
        { name: 'S2 白银', pct: 0.60 },
        { name: 'S2 参战者', pct: 1.0 },
      ];
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const all = await ratingRepo
        .createQueryBuilder('p')
        .where('p.probationGames <= 0')
        .orderBy('p.rating', 'DESC')
        .getMany();

      const eligible = all.filter((p) => p.uniqueOpponentCount >= 3);
      const myIndex = eligible.findIndex((p) => p.accountName === accountName);

      // 段位线以活跃（近7天）玩家为基础
      const active = all.filter(
        (p) => p.lastDuelAt && p.lastDuelAt.getTime() >= sevenDaysAgo,
      );
      const cutoffs = tierDefs.map((tier) => {
        const idx = Math.max(0, Math.ceil(active.length * tier.pct) - 1);
        return { name: tier.name, minRating: active.length ? active[idx].rating : 0 };
      });

      const me = all.find((p) => p.accountName === accountName);
      const tierName = me
        ? (cutoffs.find((c) => me.rating >= c.minRating)?.name || null)
        : null;

      koaCtx.body = {
        rating: me ? me.rating : 0,
        rank: myIndex === -1 ? null : myIndex + 1,
        total: eligible.length,
        tier: tierName,
        onLadder: myIndex !== -1,
      };
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/profile/avatar — 头像上传后递增版本
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/profile/avatar', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }
      const body = JSON.parse(await readBody(koaCtx));
      const database = db()!;
      const profileRepo = database.getRepository(CommunityUserProfileEntity);
      let profile = await profileRepo.findOneBy({ accountName } as any);
      if (!profile) {
        profile = new CommunityUserProfileEntity();
        profile.accountName = accountName;
      }
      if (isSameDay(profile.avatarUpdatedAt)) {
        koaCtx.body = { error: '今天已修改过头像，请明天再试' };
        return;
      }
      profile.avatarVersion += 1;
      profile.avatarUpdatedAt = new Date();
      await profileRepo.save(profile);
      koaCtx.body = { ok: true, avatarVersion: profile.avatarVersion, canChangeAvatar: false };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/posts — 帖子列表
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/posts', async (koaCtx) => {
      const database = db();
      if (!database) { koaCtx.body = { error: '数据库未启用' }; return; }

      const section = String(koaCtx.query.section || '').trim();
      const sort = String(koaCtx.query.sort || 'latest');
      const search = String(koaCtx.query.search || '').trim();
      const page = getPage(koaCtx);
      const pageSize = getPageSize(koaCtx);

      const repo = database.getRepository(CommunityPostEntity);
      let qb = repo.createQueryBuilder('post').where('post.deleteTime IS NULL');

      if (section && ['casual', 'feedback', 'deck', 'qa'].includes(section)) {
        qb = qb.andWhere('post.section = :section', { section });
      }

      if (search) {
        qb = qb.andWhere(
          '(post.title ILIKE :q OR post.content ILIKE :q OR post.authorName ILIKE :q)',
          { q: '%' + search + '%' },
        );
      }

      // 置顶帖优先
      qb = qb.orderBy('post.isPinned', 'DESC');

      if (sort === 'hot') {
        qb = qb.addOrderBy('post.likeCount', 'DESC').addOrderBy('post.createTime', 'DESC');
      } else if (sort === 'recent') {
        qb = qb.addOrderBy(
          'COALESCE(post.lastReplyAt, post.createTime)',
          'DESC',
        );
      } else {
        qb = qb.addOrderBy('post.createTime', 'DESC');
      }

      const total = await qb.getCount();
      const posts = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

      koaCtx.body = {
        total,
        page,
        pageSize,
        posts: posts.map((p) => ({
          id: Number(p.id),
          section: p.section,
          title: p.title,
          content: p.content.slice(0, 200), // 列表截断
          contentJson: (p.contentJson || []).slice(0, 3), // 预览只发前3个块
          authorName: p.authorName,
          accountName: p.accountName,
          likeCount: p.likeCount,
          replyCount: p.replyCount,
          viewCount: p.viewCount || 0,
          tags: p.tags || '',
          isPinned: p.isPinned,
          lastReplyAt: p.lastReplyAt,
          createTime: p.createTime,
        })),
      };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/posts/:id — 帖子详情
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/posts/:id', async (koaCtx) => {
      const database = db();
      if (!database) { koaCtx.body = { error: '数据库未启用' }; return; }
      const id = parseInt(koaCtx.params.id, 10);
      if (!id || id <= 0) { koaCtx.body = { error: '无效的帖子ID' }; return; }

      const repo = database.getRepository(CommunityPostEntity);
      const post = await repo.findOneBy({ id } as any);
      if (!post || post.deleteTime) {
        koaCtx.body = { error: '帖子不存在' };
        return;
      }

      // 浏览量 +1
      post.viewCount = (post.viewCount || 0) + 1;
      await repo.save(post);

      koaCtx.body = {
        id: Number(post.id),
        section: post.section,
        title: post.title,
        content: post.content,
        contentJson: post.contentJson || [],
        authorName: post.authorName,
        accountName: post.accountName,
        likeCount: post.likeCount,
        replyCount: post.replyCount,
        viewCount: post.viewCount,
        tags: post.tags || '',
        isPinned: post.isPinned,
        lastReplyAt: post.lastReplyAt,
        createTime: post.createTime,
        updateTime: post.updateTime,
      };
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/posts — 发帖
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/posts', async (koaCtx) => {
      const body = JSON.parse(await readBody(koaCtx));
      const accountName = await requireAuthFromBody(koaCtx, body);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const section = String(body.section || 'casual').trim();
      if (!['casual', 'feedback', 'deck', 'qa'].includes(section)) {
        koaCtx.status = 400;
        koaCtx.body = { error: '无效的分区' };
        return;
      }

      const title = String(body.title || '').trim().slice(0, MAX_TITLE);
      if (!title) { koaCtx.status = 400; koaCtx.body = { error: '标题不能为空' }; return; }

      const content = String(body.content || '').trim().slice(0, MAX_CONTENT);
      if (!content) { koaCtx.status = 400; koaCtx.body = { error: '内容不能为空' }; return; }

      const tags = String(body.tags || '').trim().slice(0, 100);

      // 获取显示名
      const userRepo = database.getRepository(User);
      const user = await userRepo.findOneBy({ accountName } as any);
      const authorName = user?.displayName || accountName;

      // 解析 contentJson
      let contentJson: any[] = [];
      if (body.contentJson && Array.isArray(body.contentJson)) {
        contentJson = body.contentJson.slice(0, 20); // 最多20个内容块
      } else {
        contentJson = parseContentJson(content);
      }

      const post = new CommunityPostEntity();
      post.section = section as any;
      post.title = title;
      post.content = content;
      post.contentJson = contentJson;
      post.tags = tags;
      post.accountName = accountName;
      post.authorName = authorName;
      await database.getRepository(CommunityPostEntity).save(post);

      koaCtx.body = { ok: true, id: Number(post.id) };
    });

    // ═══════════════════════════════════════════
    // DELETE /api/forum/posts/:id — 删帖
    // ═══════════════════════════════════════════
    this.ctx.router.delete('/api/forum/posts/:id', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const id = parseInt(koaCtx.params.id, 10);
      if (!id || id <= 0) { koaCtx.body = { error: '无效的帖子ID' }; return; }

      const repo = database.getRepository(CommunityPostEntity);
      const post = await repo.findOneBy({ id } as any);
      if (!post) { koaCtx.status = 404; koaCtx.body = { error: '帖子不存在' }; return; }
      if (post.accountName !== accountName) {
        koaCtx.status = 403;
        koaCtx.body = { error: '只能删除自己的帖子' };
        return;
      }

      post.deleteTime = new Date();
      await repo.save(post);
      koaCtx.body = { ok: true };
    });

    // ═══════════════════════════════════════════
    // PUT /api/forum/posts/:id — 编辑帖子
    // ═══════════════════════════════════════════
    this.ctx.router.put('/api/forum/posts/:id', async (koaCtx) => {
      const body = JSON.parse(await readBody(koaCtx));
      const accountName = await requireAuthFromBody(koaCtx, body);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const id = parseInt(koaCtx.params.id, 10);
      if (!id) { koaCtx.status = 400; koaCtx.body = { error: '无效的帖子ID' }; return; }

      const repo = database.getRepository(CommunityPostEntity);
      const post = await repo.findOneBy({ id } as any);
      if (!post || post.deleteTime) { koaCtx.status = 404; koaCtx.body = { error: '帖子不存在' }; return; }
      if (post.accountName !== accountName) {
        koaCtx.status = 403; koaCtx.body = { error: '只能编辑自己的帖子' }; return;
      }

      const title = String(body.title || '').trim().slice(0, MAX_TITLE);
      const content = String(body.content || '').trim().slice(0, MAX_CONTENT);
      if (!title) { koaCtx.status = 400; koaCtx.body = { error: '标题不能为空' }; return; }
      if (!content) { koaCtx.status = 400; koaCtx.body = { error: '内容不能为空' }; return; }

      post.title = title;
      post.content = content;
      post.contentJson = Array.isArray(body.contentJson) ? body.contentJson.slice(0, 20) : parseContentJson(content);
      post.tags = String(body.tags || '').trim().slice(0, 100);
      await repo.save(post);

      koaCtx.body = { ok: true };
    });

    // ═══════════════════════════════════════════
    // PUT /api/forum/replies/:id — 编辑回复
    // ═══════════════════════════════════════════
    this.ctx.router.put('/api/forum/replies/:id', async (koaCtx) => {
      const body = JSON.parse(await readBody(koaCtx));
      const accountName = await requireAuthFromBody(koaCtx, body);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const id = parseInt(koaCtx.params.id, 10);
      if (!id) { koaCtx.status = 400; koaCtx.body = { error: '无效的回复ID' }; return; }

      const repo = database.getRepository(CommunityReplyEntity);
      const reply = await repo.findOneBy({ id } as any);
      if (!reply) { koaCtx.status = 404; koaCtx.body = { error: '回复不存在' }; return; }
      if (reply.accountName !== accountName) {
        koaCtx.status = 403; koaCtx.body = { error: '只能编辑自己的回复' }; return;
      }

      const content = String(body.content || '').trim().slice(0, MAX_REPLY);
      if (!content) { koaCtx.status = 400; koaCtx.body = { error: '内容不能为空' }; return; }

      reply.content = content;
      reply.contentJson = Array.isArray(body.contentJson) ? body.contentJson.slice(0, 5) : [];
      await repo.save(reply);

      koaCtx.body = { ok: true };
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/posts/:id/like — 点赞 toggle
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/posts/:id/like', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const postId = parseInt(koaCtx.params.id, 10);
      if (!postId || postId <= 0) { koaCtx.body = { error: '无效的帖子ID' }; return; }

      const likeRepo = database.getRepository(CommunityLikeEntity);
      const postRepo = database.getRepository(CommunityPostEntity);

      const existing = await likeRepo.findOneBy({ accountName, postId } as any);
      const post = await postRepo.findOneBy({ id: postId } as any);
      if (!post) { koaCtx.status = 404; koaCtx.body = { error: '帖子不存在' }; return; }

      if (existing) {
        await likeRepo.remove(existing);
        post.likeCount = Math.max(0, post.likeCount - 1);
        await postRepo.save(post);
        koaCtx.body = { ok: true, liked: false, likeCount: post.likeCount };
      } else {
        const like = new CommunityLikeEntity();
        like.accountName = accountName;
        like.postId = postId;
        await likeRepo.save(like);
        post.likeCount += 1;
        await postRepo.save(post);
        koaCtx.body = { ok: true, liked: true, likeCount: post.likeCount };
      }
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/posts/:id/pin — 置顶/取消置顶（仅管理员）
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/posts/:id/pin', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      // 检查是否是管理员（sudo权限）
      const userRepo = database.getRepository(User);
      const user = await userRepo.findOneBy({ accountName } as any);
      if (!user || user.enabled === false || !user.permissions || !user.permissions.split(',').some((p: string) => p.trim() === 'sudo')) {
        koaCtx.status = 403;
        koaCtx.body = { error: '权限不足，仅管理员可操作' };
        return;
      }

      const body = JSON.parse(await readBody(koaCtx));
      const postId = parseInt(koaCtx.params.id, 10);
      if (!postId || postId <= 0) { koaCtx.body = { error: '无效的帖子ID' }; return; }

      const postRepo = database.getRepository(CommunityPostEntity);
      const post = await postRepo.findOneBy({ id: postId } as any);
      if (!post || post.deleteTime) { koaCtx.status = 404; koaCtx.body = { error: '帖子不存在' }; return; }

      post.isPinned = body.pinned !== false; // 默认 true
      await postRepo.save(post);

      koaCtx.body = { ok: true, isPinned: post.isPinned };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/posts/:id/replies — 回复列表
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/posts/:id/replies', async (koaCtx) => {
      const database = db();
      if (!database) { koaCtx.body = { error: '数据库未启用' }; return; }

      const postId = parseInt(koaCtx.params.id, 10);
      if (!postId) { koaCtx.body = { error: '无效的帖子ID' }; return; }

      const page = getPage(koaCtx);
      const pageSize = getPageSize(koaCtx, 20);
      const repo = database.getRepository(CommunityReplyEntity);
      const [replies, total] = await repo.findAndCount({
        where: { postId } as any,
        order: { createTime: 'ASC' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      koaCtx.body = {
        total,
        page,
        pageSize,
        replies: replies.map((r) => ({
          id: Number(r.id),
          postId: Number(r.postId),
          content: r.content,
          contentJson: r.contentJson || [],
          authorName: r.authorName,
          accountName: r.accountName,
          createTime: r.createTime,
        })),
      };
    });

    // ═══════════════════════════════════════════
    // POST /api/forum/posts/:id/replies — 发表回复
    // ═══════════════════════════════════════════
    this.ctx.router.post('/api/forum/posts/:id/replies', async (koaCtx) => {
      const body = JSON.parse(await readBody(koaCtx));
      const accountName = await requireAuthFromBody(koaCtx, body);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const postId = parseInt(koaCtx.params.id, 10);
      if (!postId) { koaCtx.status = 400; koaCtx.body = { error: '无效的帖子ID' }; return; }

      const postRepo = database.getRepository(CommunityPostEntity);
      const post = await postRepo.findOneBy({ id: postId } as any);
      if (!post || post.deleteTime) { koaCtx.status = 404; koaCtx.body = { error: '帖子不存在' }; return; }

      const content = String(body.content || '').trim().slice(0, MAX_REPLY);
      if (!content) { koaCtx.status = 400; koaCtx.body = { error: '回复内容不能为空' }; return; }

      const userRepo = database.getRepository(User);
      const user = await userRepo.findOneBy({ accountName } as any);
      const authorName = user?.displayName || accountName;

      const reply = new CommunityReplyEntity();
      reply.postId = postId;
      reply.content = content;
      reply.contentJson = body.contentJson && Array.isArray(body.contentJson)
        ? body.contentJson.slice(0, 5)
        : [];
      reply.accountName = accountName;
      reply.authorName = authorName;
      await database.getRepository(CommunityReplyEntity).save(reply);

      post.replyCount += 1;
      post.lastReplyAt = new Date();
      await postRepo.save(post);

      koaCtx.body = { ok: true, id: Number(reply.id), replyCount: post.replyCount };
    });

    // ═══════════════════════════════════════════
    // DELETE /api/forum/replies/:id — 删回复
    // ═══════════════════════════════════════════
    this.ctx.router.delete('/api/forum/replies/:id', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const id = parseInt(koaCtx.params.id, 10);
      if (!id) { koaCtx.body = { error: '无效的回复ID' }; return; }

      const repo = database.getRepository(CommunityReplyEntity);
      const reply = await repo.findOneBy({ id } as any);
      if (!reply) { koaCtx.status = 404; koaCtx.body = { error: '回复不存在' }; return; }
      if (reply.accountName !== accountName) {
        koaCtx.status = 403;
        koaCtx.body = { error: '只能删除自己的回复' };
        return;
      }

      await repo.remove(reply);

      // 更新帖子的回复计数
      const postRepo = database.getRepository(CommunityPostEntity);
      const post = await postRepo.findOneBy({ id: reply.postId } as any);
      if (post) {
        post.replyCount = Math.max(0, post.replyCount - 1);
        await postRepo.save(post);
      }

      koaCtx.body = { ok: true };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/my-posts — 我的发帖
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/my-posts', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const page = getPage(koaCtx);
      const pageSize = getPageSize(koaCtx);
      const repo = database.getRepository(CommunityPostEntity);
      const [posts, total] = await repo.findAndCount({
        where: { accountName, deleteTime: null as any } as any,
        order: { createTime: 'DESC' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      koaCtx.body = {
        total, page, pageSize,
        posts: posts.map((p) => ({
          id: Number(p.id),
          section: p.section,
          title: p.title,
          replyCount: p.replyCount,
          likeCount: p.likeCount,
          createTime: p.createTime,
        })),
      };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/my-replies — 我的回复
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/my-replies', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const page = getPage(koaCtx);
      const pageSize = getPageSize(koaCtx);
      const replyRepo = database.getRepository(CommunityReplyEntity);

      const [replies, total] = await replyRepo.findAndCount({
        where: { accountName } as any,
        order: { createTime: 'DESC' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      // 批量查帖子标题
      const postIds = [...new Set(replies.map((r) => Number(r.postId)))];
      const postRepo = database.getRepository(CommunityPostEntity);
      const posts: CommunityPostEntity[] = postIds.length
        ? await postRepo.findBy({ id: In(postIds) } as any) as CommunityPostEntity[]
        : [];

      const postMap = new Map<number, CommunityPostEntity>(
        posts.map((p) => [Number(p.id), p]),
      );

      koaCtx.body = {
        total, page, pageSize,
        replies: replies.map((r) => {
          const post = postMap.get(Number(r.postId));
          return {
            id: Number(r.id),
            postId: Number(r.postId),
            postTitle: post?.title || '(已删除)',
            postDeleted: !post,
            content: r.content.slice(0, 150),
            createTime: r.createTime,
          };
        }),
      };
    });

    // ═══════════════════════════════════════════
    // GET /api/forum/liked-posts — 点赞过的帖子
    // ═══════════════════════════════════════════
    this.ctx.router.get('/api/forum/liked-posts', async (koaCtx) => {
      const accountName = await requireAuth(koaCtx);
      if (!accountName) { auth403(koaCtx); return; }

      const database = db()!;
      const page = getPage(koaCtx);
      const pageSize = getPageSize(koaCtx);
      const likeRepo = database.getRepository(CommunityLikeEntity);

      const [likes, total] = await likeRepo.findAndCount({
        where: { accountName } as any,
        order: { createTime: 'DESC' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      const postIds = likes.map((l) => Number(l.postId));
      const postRepo = database.getRepository(CommunityPostEntity);
      const posts: CommunityPostEntity[] = postIds.length
        ? await postRepo.findBy({ id: In(postIds) } as any) as CommunityPostEntity[]
        : [];

      const postMap = new Map<number, CommunityPostEntity>(
        posts.map((p) => [Number(p.id), p]),
      );

      koaCtx.body = {
        total, page, pageSize,
        posts: likes
          .map((l) => {
            const post = postMap.get(Number(l.postId));
            if (!post || post.deleteTime) return null;
            return {
              id: Number(post.id),
              section: post.section,
              title: post.title,
              authorName: post.authorName,
              likeCount: post.likeCount,
              replyCount: post.replyCount,
              createTime: post.createTime,
            };
          })
          .filter(Boolean),
      };
    });

  }
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

function isSameDay(date?: Date): boolean {
  if (!date) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function parseContentJson(content: string): any[] {
  const blocks: any[] = [];
  const regex = /\[deck\]([\s\S]*?)\[\/deck\]|\[card\](\d+)\[\/card\]/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // 前面的纯文本
    if (match.index > lastIdx) {
      const text = content.slice(lastIdx, match.index).trim();
      if (text) blocks.push({ type: 'text', text });
    }
    if (match[1] !== undefined) {
      // deck block
      const ydkText = match[1].trim();
      const deck = parseYdkText(ydkText);
      blocks.push({ type: 'deck', ydk: ydkText, main: deck.main, extra: deck.extra, side: deck.side });
    } else if (match[2] !== undefined) {
      // card block
      blocks.push({ type: 'card', id: parseInt(match[2], 10) });
    }
    lastIdx = match.index + match[0].length;
  }

  // 剩余文本
  if (lastIdx < content.length) {
    const text = content.slice(lastIdx).trim();
    if (text) blocks.push({ type: 'text', text });
  }

  // 如果解析后没有任何 block，存原始文本
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: content });
  }

  return blocks;
}

function parseYdkText(text: string): { main: number[]; extra: number[]; side: number[] } {
  const main: number[] = [];
  const extra: number[] = [];
  const side: number[] = [];
  let section: 'main' | 'extra' | 'side' = 'main';
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#extra/i.test(trimmed)) { section = 'extra'; continue; }
    if (/^!side/i.test(trimmed)) { section = 'side'; continue; }
    if (/^#/.test(trimmed)) continue;
    const id = parseInt(trimmed, 10);
    if (!isNaN(id) && id > 0) {
      if (section === 'main') main.push(id);
      else if (section === 'extra') extra.push(id);
      else side.push(id);
    }
  }
  return { main, extra, side };
}
