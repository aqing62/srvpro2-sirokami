import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { OnRoomJoin } from '../../room/room-event/on-room-join';
import { KoishiContextService } from '../../koishi/koishi-context-service';
import { UserService } from './user-service';

declare module '../../client' {
  interface Client {
    loggedIn: boolean;
    accountName?: string;
    displayName?: string;
    title?: string;
    ladderTitle?: string;
  }
}

export class LoginService {
  private koishiContextService = this.ctx.get(() => KoishiContextService);
  private userService = this.ctx.get(() => UserService);

  /** IP → 用户名 自动登录映射（启动时从DB恢复，登录时持久化到DB） */
  private ipUserMap = new Map<string, string>();

  constructor(private ctx: Context) {}

  async init() {
    const koishi = this.koishiContextService.instance;

    // 启动时从数据库恢复 IP 映射
    await this.loadIpMapFromDb();

    // 进房自动登录：匹配 IP（优先查内存Map，兜底查DB）
    this.ctx.middleware(OnRoomJoin, async (_event, client, next) => {
      if (client.loggedIn) return next();

      const ip = client.ip;
      if (!ip || ip === 'unknown') return next();

      let username = this.ipUserMap.get(ip);
      if (!username) {
        // 兜底：查数据库 lastIp
        const user = await this.userService.findByIp(ip);
        if (user) {
          username = user.accountName;
          this.ipUserMap.set(ip, username);
        }
      }

      if (!username) return next();

      const user = await this.userService.findByName(username);
      if (!user || user.enabled === false) {
        this.ipUserMap.delete(ip);
        return next();
      }

      client.loggedIn = true;
      client.accountName = username;
      client.displayName = user.displayName || username;
      client.title = user.title || '';
      client.ladderTitle = user.ladderTitle || '';
      return next();
    });

    // /whoami - 查看登录状态
    this.koishiContextService
      .attachI18n('whoami', { description: '查看登录状态' });
    koishi.command('whoami', '查看登录状态').action(async ({ session }) => {
      const ctx = this.koishiContextService.resolveCommandContext(session);
      if (!ctx) return;
      const { client } = ctx;
      if (client.loggedIn) {
        const name = client.displayName || client.accountName;
        await client.sendChat(
          `已登录: ${name} (账号: ${client.accountName})`,
          ChatColor.GREEN,
        );
      } else {
        await client.sendChat(
          '未登录，请输入 /login 「用户名」「密码」 登录',
          ChatColor.YELLOW,
        );
      }
    });

    // /register 「用户名」「密码」 「显示名」 - 注册
    this.koishiContextService
      .attachI18n('register', { description: '注册账号' });
    koishi.command('register [...args]', '注册账号').action(async ({ session }) => {
      const ctx = this.koishiContextService.resolveCommandContext(session);
      if (!ctx) return;
      const { client } = ctx;

      let content = (session.content || '').trim();
      content = content.replace(/^\/register[\s]*/i, '');
      const parts = content.split(/\s+/);
      if (parts.length < 2) {
        await client.sendChat(
          '用法: /register 「用户名」「密码」 「显示名(可选)」',
          ChatColor.YELLOW,
        );
        return;
      }
      const username = parts[0];
      const password = parts[1];
      const customName = parts.slice(2).join(' ') || undefined;

      const existing = await this.userService.findByName(username);
      if (existing) {
        await client.sendChat('该用户名已被注册', ChatColor.RED);
        return;
      }

      await this.userService.createUser(username, password, customName);

      client.loggedIn = true;
      client.accountName = username;
      client.displayName = customName || username;
      client.title = '';
      client.ladderTitle = '';

      this.recordAutoLoginIp(client, username);

      await client.sendChat(
        `注册成功！账号: ${username}  显示名: ${client.displayName}`,
        ChatColor.GREEN,
      );
    });

    // /login 「用户名」「密码」 [显示名] - 登录
    this.koishiContextService
      .attachI18n('login', { description: '登录游戏' });
    koishi.command('login [...args]', '登录游戏').action(async ({ session }) => {
      const ctx = this.koishiContextService.resolveCommandContext(session);
      if (!ctx) return;
      const { client } = ctx;

      // 解析参数
      let content = (session.content || '').trim();
      content = content.replace(/^\/login[\s]*/i, '');
      const parts = content.split(/\s+/);
      if (parts.length < 2) {
        await client.sendChat(
          '用法: /login 「用户名」「密码」  首次请用 /register 「用户名」「密码」 「显示名」',
          ChatColor.YELLOW,
        );
        return;
      }
      const username = parts[0];
      const password = parts[1];
      const customName = parts.slice(2).join(' ') || undefined;

      const entry = await this.userService.findByName(username);

      if (!entry) {
        await client.sendChat(
          '用户不存在，请使用 /register 「用户名」「密码」 「显示名」 注册',
          ChatColor.RED,
        );
        return;
      }

      if (entry.enabled === false) {
        await client.sendChat('该账号已被禁用', ChatColor.RED);
        return;
      }
      if (entry.password !== password) {
        await client.sendChat('密码错误', ChatColor.RED);
        return;
      }

      client.loggedIn = true;
      client.accountName = username;
      client.title = entry.title || '';
      client.ladderTitle = entry.ladderTitle || '';

      this.recordAutoLoginIp(client, username);

      if (customName) {
        client.displayName = customName;
        await this.userService.updateDisplayName(username, customName);
      } else if (entry.displayName) {
        client.displayName = entry.displayName;
      } else {
        client.displayName = username;
      }

      const perm = entry.permissions || '无';
      await client.sendChat(
        `登录成功！账号: ${username}  显示名: ${client.displayName}  权限: ${perm}`,
        ChatColor.GREEN,
      );
    });

    // 入房提示
    this.ctx.middleware(OnRoomJoin, async (_event, client, next) => {
      if (client.loggedIn) {
        const room = _event.room;
        const name = client.displayName || client.accountName;
        const badges: string[] = [];
        if (client.ladderTitle) badges.push(client.ladderTitle);
        if (client.title) badges.push(client.title);
        const suffix = badges.length ? ` 🏆${badges.join(' · ')}` : '';
        await room.sendChat(
          `欢迎 ${name}${suffix} 进入房间`,
          ChatColor.GREEN,
        );
      } else {
        await client.sendChat(
          '未登录，请输入 /login 「用户名」「密码」 登录  (首次请用 /register 「用户名」「密码」 「显示名」 注册)',
          ChatColor.YELLOW,
        );
      }
      return next();
    });
  }

  /** 从数据库加载所有 lastIp → username 映射 */
  private async loadIpMapFromDb() {
    const users = await this.userService.getAllWithIp();
    for (const u of users) {
      if (u.lastIp && u.lastIp !== 'unknown') {
        this.ipUserMap.set(u.lastIp, u.accountName);
      }
    }
    this.ctx.createLogger('LoginService').info(`Loaded ${this.ipUserMap.size} IP mappings from DB`);
  }

  /** 记录 IP 到内存和数据库 */
  private recordAutoLoginIp(client: { ip: string }, username: string) {
    const ip = client.ip;
    if (ip && ip !== 'unknown') {
      this.ipUserMap.set(ip, username);
      this.userService.updateLastIp(username, ip).catch(() => {});
    }
  }
}
