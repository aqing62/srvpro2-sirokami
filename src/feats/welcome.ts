import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { OnRoomJoin } from '../room/room-event/on-room-join';
import { ValueContainer } from '../utility/value-container';
import { DuelStage } from '../room';

declare module '../room' {
  interface Room {
    welcome: string;
    welcome2: string;
  }
}

declare module '../client' {
  interface Client {
    configWelcomeSent?: boolean;
  }
}

export class Welcome {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(OnRoomJoin, async (event, client, next) => {
      const room = event.room;
      await this.sendConfigWelcome(client);
      if (room.duelStage !== DuelStage.Begin) {
        return next();
      }
      if (room.welcome) {
        await client.sendChat(room.welcome, ChatColor.BABYBLUE);
      }
      if (room.welcome2) {
        await client.sendChat(room.welcome2, ChatColor.PINK);
      }
      return next();
    });
  }

  async sendConfigWelcome(client: Client) {
    const welcomeMessage = await this.getConfigWelcome(client);
    if (!welcomeMessage || client.configWelcomeSent) {
      return;
    }
    client.configWelcomeSent = true;
    await client.sendChat(welcomeMessage, ChatColor.GREEN);
  }

  async getConfigWelcome(client: Client) {
    const baseWelcome = this.ctx.config.getString('WELCOME');
    const event = await this.ctx.dispatch(
      new WelcomeConfigCheck(client, baseWelcome),
      client,
    );
    return event?.value || '';
  }
}

export class WelcomeConfigCheck extends ValueContainer<string> {
  constructor(
    public client: Client,
    initialValue: string,
  ) {
    super(initialValue);
  }
}
