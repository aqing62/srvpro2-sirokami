import { RoomEvent } from './room-event';
import { Room } from '../room';

export class OnRoomLeave extends RoomEvent {
  constructor(
    room: Room,
    public otherDisconnectedCount = 0,
  ) {
    super(room);
  }
}
