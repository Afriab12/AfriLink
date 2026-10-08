import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsObject, ValidateNested } from 'class-validator';
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  NOTIFICATION_PREFERENCE_CHANNELS,
  type NotificationPreferenceCategory,
  type NotificationPreferenceChannel,
} from '../notifications.service';

export class NotificationPreferenceUpdateDto {
  @IsIn([...NOTIFICATION_PREFERENCE_CATEGORIES])
  category!: NotificationPreferenceCategory;

  @IsIn([...NOTIFICATION_PREFERENCE_CHANNELS])
  channel!: NotificationPreferenceChannel;

  @IsBoolean()
  enabled!: boolean;
}

export class UpdateNotificationPreferencesDto {
  @IsArray()
  @ArrayUnique((preference: NotificationPreferenceUpdateDto | null) =>
    preference == null ? preference : `${preference.category}:${preference.channel}`,
  )
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceUpdateDto)
  preferences!: NotificationPreferenceUpdateDto[];
}
