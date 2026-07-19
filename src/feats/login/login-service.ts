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
  }
}

export class LoginService {
  private koishiContextService = this.ctx.get(() => KoishiContextService);
  private userService = this.ctx.get(() => UserService);

  /** IP → 用户名 自动登录映射（仅内存，重启清空） */
  private ipUserMap = new Map<string, string>();

  constructor(private ctx: Context) {}

  async init() {
    const koishi = this.koishiContextService.instance;

    // 进房自动登录：匹配 IP
    this.ctx.middleware(OnRoomJoin, async (_event, client, next) => {
      if (client.loggedIn) return next();

      const ip = client.ip;
      if (!ip || ip === 'unknown') return next();

      const username = this.ipUserMap.get(ip);
      if (!username) return next();

      const user = await this.userService.findByName(username);
      if (!user || user.enabled === false) {
        this.ipUserMap.delete(ip);
        return next();
      }

      client.loggedIn = true;
      client.accountName = username;
      client.displayName = user.displayName || username;
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
        const name = client.displayName || client.accountName;
        await client.sendChat(
          `欢迎回来，${name}！(账号: ${client.accountName})`,
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

  /** 记录 IP，用于后续自动登录 */
  private recordAutoLoginIp(client: { ip: string }, username: string) {
    const ip = client.ip;
    if (ip && ip !== 'unknown') {
      this.ipUserMap.set(ip, username);
    }
  }
}
