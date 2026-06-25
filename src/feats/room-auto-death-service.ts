import { Context } from '../app';
import {
  DefaultHostInfoProvider,
  OnRoomFinalize,
  OnRoomGameStart,
  RoomManager,
} from '../room';
import { RoomDeathService } from './room-death-service';
import { ChatColor } from 'ygopro-msg-encode';

const MINUTE_MS = 60_000;

declare module 'ygopro-msg-encode' {
  interface HostInfo {
    auto_death?: number;
  }
}

export class RoomAutoDeathService {
  private logger = this.ctx.createLogger('RoomAutoDeathService');
  private roomManager = this.ctx.get(() => RoomManager);
  private roomDeathService = this.ctx.get(() => RoomDeathService);
  private roomTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private ctx: Context) {
    this.ctx
      .get(() => DefaultHostInfoProvider)
      .registerRoomMode('(DEATH|DH)(\\d*)', ({ regexResult }) => {
        const deathTime = Number.parseInt(regexResult[1], 10);
        return {
          auto_death:
            Number.isFinite(deathTime) && deathTime > 0 ? deathTime : 40,
        };
      });
  }

  async init() {
    this.ctx.middleware(OnRoomGameStart, async (event, _client, next) => {
      const scheduled = this.tryScheduleAutoDeath(
        event.room.name,
        event.room.hostinfo.auto_death,
      );
      if (scheduled) {
        const minutes = Number(event.room.hostinfo.auto_death || 0);
        await event.room.sendChat(
          `#{auto_death_part1}${minutes}#{auto_death_part2}`,
          ChatColor.BABYBLUE,
        );
      }
      return next();
    });

    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      this.clearTimer(event.room.name);
      return next();
    });
  }

  private tryScheduleAutoDeath(roomName: string, autoDeathMinutes?: number) {
    const minutes = Number(autoDeathMinutes || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return false;
    }
    if (this.roomTimers.has(roomName)) {
      return false;
    }

    const delayMs = Math.max(0, Math.floor(minutes * MINUTE_MS));
    const timer = setTimeout(() => {
      this.roomTimers.delete(roomName);
      void this.triggerAutoDeath(roomName).catch((error) => {
        this.logger.warn(
          { roomName, error },
          'Failed to trigger auto death for room',
        );
      });
    }, delayMs);
    this.roomTimers.set(roomName, timer);
    return true;
  }

  private clearTimer(roomName: string) {
    const timer = this.roomTimers.get(roomName);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.roomTimers.delete(roomName);
  }

  private async triggerAutoDeath(roomName: string) {
    const room = this.roomManager.findByName(roomName);
    if (!room || room.finalizing) {
      return;
    }
    await this.roomDeathService.startDeath(room);
  }
}
