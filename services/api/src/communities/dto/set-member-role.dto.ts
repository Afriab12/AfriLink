import { IsIn } from 'class-validator';
import { MEMBER_ROLES } from '../communities.constants';

// 'owner' is not assignable: ownership is communities.owner_user_id and
// transferring it is out of scope.
export class SetMemberRoleDto {
  @IsIn(MEMBER_ROLES)
  role!: (typeof MEMBER_ROLES)[number];
}
