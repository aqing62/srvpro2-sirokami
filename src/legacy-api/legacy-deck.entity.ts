import { BaseTimeEntity, BigintTransformer } from '../utility';
import { Column, Entity, Generated, Index, PrimaryColumn } from 'typeorm';

@Entity('legacy_deck')
export class LegacyDeckEntity extends BaseTimeEntity {
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
    length: 128,
  })
  name!: string;

  @Column({
    type: 'text',
  })
  payload!: string;

  @Column('smallint')
  mainc!: number;

  @Index()
  @Column({
    type: 'timestamp',
  })
  uploadTime!: Date;
}
