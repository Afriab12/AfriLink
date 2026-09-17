import { IsIn } from 'class-validator';

export class ListFriendRequestsQueryDto {
  @IsIn(['incoming', 'outgoing'])
  direction!: 'incoming' | 'outgoing';
}
