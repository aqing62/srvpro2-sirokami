import { YGOProMsgWin } from 'ygopro-msg-encode';
import { Room } from '../room';
import { RoomEvent } from './room-event';

export class OnRoomWin extends RoomEvent {
  constructor(
    room: Room,
    public winMsg: YGOProMsgWin,
    public winMatch = false,
    public wasSwapped = false,
  ) {
    super(room);
  }
}
