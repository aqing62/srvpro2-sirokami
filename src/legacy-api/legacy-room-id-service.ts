import { Context } from '../app';
import { OnRoomCreate, OnRoomFinalize } from '../room';

const ROOM_ID_PREFIX_LENGTH = 10;
const ROOM_ID_BASE = 1_000_000;
const ROOM_ID_MOD = 9_000_000;

export class LegacyRoomIdService {
  private logger = this.ctx.createLogger('LegacyRoomIdService');
  private roomNameToRoomId = new Map<string, string>();
  private roomIdToRoomName = new Map<string, string>();

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(OnRoomCreate, async (event, client, next) => {
      this.bindRoom(event.room.name, event.room.identifier);
      return next();
    });
    this.ctx.middleware(OnRoomFinalize, async (event, client, next) => {
      this.releaseRoom(event.room.name);
      return next();
    });
  }

  getRoomIdString(identifier: string) {
    return String(this.getRoomIdNumber(identifier));
  }

  findRoomNameByRoomId(roomIdText: string) {
    const normalizedRoomId = this.normalizeRoomId(roomIdText);
    if (!normalizedRoomId) {
      return undefined;
    }
    return this.roomIdToRoomName.get(normalizedRoomId);
  }

  getRoomIdNumber(identifier: string) {
    const prefix = String(identifier || '').slice(0, ROOM_ID_PREFIX_LENGTH);
    let value = 0n;
    for (const ch of prefix) {
      value = value * 62n + BigInt(this.toBase62Digit(ch));
    }
    return Number(value % BigInt(ROOM_ID_MOD)) + ROOM_ID_BASE;
  }

  private toBase62Digit(ch: string) {
    if (ch >= '0' && ch <= '9') {
      return ch.charCodeAt(0) - 48;
    }
    if (ch >= 'A' && ch <= 'Z') {
      return ch.charCodeAt(0) - 55;
    }
    if (ch >= 'a' && ch <= 'z') {
      return ch.charCodeAt(0) - 61;
    }
    return 0;
  }

  private bindRoom(roomName: string, identifier: string) {
    const roomId = this.getRoomIdString(identifier);
    const occupiedRoomName = this.roomIdToRoomName.get(roomId);
    if (occupiedRoomName && occupiedRoomName !== roomName) {
      this.logger.warn(
        {
          roomId,
          currentRoomName: occupiedRoomName,
          nextRoomName: roomName,
        },
        'Legacy room id collision detected',
      );
    }
    const previousRoomId = this.roomNameToRoomId.get(roomName);
    if (previousRoomId && previousRoomId !== roomId) {
      const linkedRoomName = this.roomIdToRoomName.get(previousRoomId);
      if (linkedRoomName === roomName) {
        this.roomIdToRoomName.delete(previousRoomId);
      }
    }
    this.roomNameToRoomId.set(roomName, roomId);
    this.roomIdToRoomName.set(roomId, roomName);
  }

  private releaseRoom(roomName: string) {
    const roomId = this.roomNameToRoomId.get(roomName);
    if (!roomId) {
      return;
    }
    this.roomNameToRoomId.delete(roomName);
    const linkedRoomName = this.roomIdToRoomName.get(roomId);
    if (linkedRoomName === roomName) {
      this.roomIdToRoomName.delete(roomId);
    }
  }

  private normalizeRoomId(roomIdText: string) {
    const text = String(roomIdText || '').trim();
    if (!/^\d+$/.test(text)) {
      return undefined;
    }
    const roomId = Number(text);
    if (!Number.isSafeInteger(roomId)) {
      return undefined;
    }
    if (roomId < ROOM_ID_BASE || roomId >= ROOM_ID_BASE + ROOM_ID_MOD) {
      return undefined;
    }
    return String(roomId);
  }
}
