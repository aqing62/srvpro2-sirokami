import type { DataSource } from 'typeorm';
import type Router from '@koa/router';
import { CommunityPostEntity } from './community-post.entity';
import { CommunityReplyEntity } from './community-reply.entity';
import { CommunityLikeEntity } from './community-like.entity';
import { CommunityUserProfileEntity } from './community-user-profile.entity';
import { User } from '../login';
import { In } from 'typeorm';

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
      const page = getPage(koaCtx);
      const pageSize = getPageSize(koaCtx);

      const repo = database.getRepository(CommunityPostEntity);
      let qb = repo.createQueryBuilder('post').where('post.deleteTime IS NULL');

      if (section && ['casual', 'feedback', 'deck', 'qa'].includes(section)) {
        qb = qb.andWhere('post.section = :section', { section });
      }

      // 置顶帖优先
      qb = qb.orderBy('post.isPinned', 'DESC');

      if (sort === 'hot') {
        qb = qb.addOrderBy('post.likeCount', 'DESC').addOrderBy('post.createTime', 'DESC');
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
          isPinned: p.isPinned,
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
        isPinned: post.isPinned,
        createTime: post.createTime,
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
