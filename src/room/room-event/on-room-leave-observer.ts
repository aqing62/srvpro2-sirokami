import { Room } from '../room';
import { RoomEvent } from './room-event';

export enum RoomLeaveObserverReason {
  Disconnect = 'disconnect',
  ToDuelist = 'to_duelist',
}

export class OnRoomLeaveObserver extends RoomEvent {
  constructor(
    room: Room,
    public reason: RoomLeaveObserverReason,
    public bySystem = false,
    public otherDisconnectedCount = 0,
  ) {
    super(room);
  }
}
