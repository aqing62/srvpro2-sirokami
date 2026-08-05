import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('community_user_profile')
export class CommunityUserProfileEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  accountName!: string;

  @Column({ type: 'int', default: 1 })
  avatarVersion = 1;

  @Column({ type: 'varchar', length: 64, default: '' })
  displayName = '';

  @Column({ type: 'timestamp', nullable: true })
  avatarUpdatedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  nameUpdatedAt?: Date;
}
