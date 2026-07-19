import { BaseTimeEntity } from '../../utility';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('srv_user')
export class User extends BaseTimeEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  accountName!: string;

  @Column({ type: 'varchar', length: 128 })
  password!: string;

  @Column({ type: 'boolean', default: true })
  enabled = true;

  /**
   * Permission set name (e.g. "sudo", "judge", "streamer")
   * or JSON string for inline permission objects.
   */
  @Column({ type: 'varchar', length: 64, default: '' })
  permissions = '';

  @Column({ type: 'varchar', length: 64, nullable: true })
  displayName?: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  title = ''; // 天梯称号，如「S1冠军」，管理员手动赋值

  @Column({ type: 'varchar', length: 64, default: '' })
  lastIp = ''; // 最近登录IP，用于自动登录恢复
}
