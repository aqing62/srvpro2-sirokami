import { BigintTransformer } from '../../utility';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('community_like')
@Index(['accountName', 'postId'], { unique: true })
export class CommunityLikeEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  accountName!: string;

  @PrimaryColumn({ type: 'bigint', unsigned: true, transformer: new BigintTransformer() })
  postId!: number;

  @CreateDateColumn()
  createTime!: Date;
}
