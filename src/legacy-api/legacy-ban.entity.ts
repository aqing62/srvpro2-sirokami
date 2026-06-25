import { BaseTimeEntity, BigintTransformer } from '../utility';
import {
  Column,
  Entity,
  Generated,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

@Entity('legacy_ban')
@Unique(['ip', 'name'])
export class LegacyBanEntity extends BaseTimeEntity {
  @PrimaryColumn({
    type: 'bigint',
    unsigned: true,
    transformer: new BigintTransformer(),
  })
  @Generated('increment')
  id!: number;

  @Index()
  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  ip!: string | null;

  @Index()
  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  name!: string | null;
}
