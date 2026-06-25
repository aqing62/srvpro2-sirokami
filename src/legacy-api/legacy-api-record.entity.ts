import { BaseTimeEntity, BigintTransformer } from '../utility';
import { Column, Entity, Generated, Index, PrimaryColumn } from 'typeorm';

@Entity('legacy_api_record')
export class LegacyApiRecordEntity extends BaseTimeEntity {
  @PrimaryColumn({
    type: 'bigint',
    unsigned: true,
    transformer: new BigintTransformer(),
  })
  @Generated('increment')
  id!: number;

  @Index({ unique: true })
  @Column({
    type: 'varchar',
    length: 64,
  })
  key!: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  value!: string | null;
}
