import { Room } from '../room';
import { RoomEvent } from './room-event';

export enum RoomLeavePlayerReason {
  Disconnect = 'disconnect',
  ToObserver = 'to_observer',
  SwitchPosition = 'switch_position',
}

export class OnRoomLeavePlayer extends RoomEvent {
  constructor(
    room: Room,
    public oldPos: number,
    public reason: RoomLeavePlayerReason,
    public bySystem = false,
    public otherDisconnectedCount = 0,
  ) {
    super(room);
  }
}
