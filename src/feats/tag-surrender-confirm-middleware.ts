import {
  NetPlayerType,
  YGOProCtosSurrender,
  YGOProMsgNewTurn,
  YGOProStocTeammateSurrender,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { YGOProCtosDisconnect } from '../utility/ygopro-ctos-disconnect';
import { Room, DuelStage, RoomManager } from '../room';

export class TagSurrenderConfirmMiddleware {
  // Track per-room pending teammate-confirm surrender by player position.
  private pendingByRoom = new WeakMap<Room, Set<number>>();

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProMsgNewTurn, async (msg, client, next) => {
      const room = this.getRoom(client);
      if (room?.isTag && (msg.player & 0x2) === 0) {
        this.pendingByRoom.delete(room);
      }
      return next();
    });

    this.ctx.middleware(
      YGOProCtosSurrender,
      async (_msg, client, next) => {
        const room = this.getRoom(client);
        if (
          !room ||
          !room.isTag ||
          room.duelStage !== DuelStage.Dueling ||
          client.pos >= NetPlayerType.OBSERVER
        ) {
          return next();
        }

        if (client.isInternal) {
          // Internal client surrender is always immediate.
          return next();
        }

        const teammate = this.getTeammate(room, client);
        if (!teammate || teammate.isInternal || teammate.disconnected) {
          // No consent needed if teammate is internal or disconnected.
          this.clearPending(room);
          return next();
        }

        const pending = this.getPending(room);
        if (pending.has(client.pos)) {
          // Duplicate request while already waiting consent.
          return;
        }

        if (pending.has(teammate.pos)) {
          // Teammate already requested surrender, confirm and pass through.
          this.clearPending(room);
          return next();
        }

        pending.add(client.pos);
        await Promise.all([
          client.send(new YGOProStocTeammateSurrender()),
          teammate.send(new YGOProStocTeammateSurrender()),
        ]);
        return;
      },
      true,
    );

    this.ctx.middleware(
      YGOProCtosDisconnect,
      async (_msg, client, next) => {
        const room = this.getRoom(client);
        if (
          !room ||
          !room.isTag ||
          room.duelStage !== DuelStage.Dueling ||
          client.pos >= NetPlayerType.OBSERVER
        ) {
          return next();
        }

        const pending = this.pendingByRoom.get(room);
        if (!pending || pending.size === 0) {
          return next();
        }

        const teammate = this.getTeammate(room, client);
        if (!teammate) {
          return next();
        }

        // If this disconnecting client is the "waiting for consent" side,
        // treat teammate's pending surrender as confirmed.
        if (pending.has(teammate.pos) && !pending.has(client.pos)) {
          const surrenderClient = teammate;
          this.clearPending(room);
          if (surrenderClient) {
            await room.win({
              player: 1 - room.getIngameDuelPos(surrenderClient),
              type: 0x0,
            });
          }
        }

        // Clear stale pending state when requester disconnects.
        if (pending.has(client.pos)) {
          this.clearPending(room);
        }

        return next();
      },
      true,
    );
  }

  private getRoom(client: Client): Room | undefined {
    if (!client.roomName) {
      return;
    }
    return this.ctx.get(() => RoomManager).findByName(client.roomName);
  }

  private getPending(room: Room): Set<number> {
    const existing = this.pendingByRoom.get(room);
    if (existing) {
      return existing;
    }
    const created = new Set<number>();
    this.pendingByRoom.set(room, created);
    return created;
  }

  private clearPending(room: Room) {
    this.pendingByRoom.delete(room);
  }

  private getTeammate(room: Room, client: Client): Client | undefined {
    const duelPos = room.getDuelPos(client);
    if (duelPos < 0) {
      return undefined;
    }
    return room.getDuelPosPlayers(duelPos).find((p) => p !== client);
  }
}
