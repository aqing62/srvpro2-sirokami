import { BaseTimeEntity, BigintTransformer } from '../../utility';
import { Column, Entity, Generated, Index, PrimaryColumn } from 'typeorm';

@Entity('community_reply')
export class CommunityReplyEntity extends BaseTimeEntity {
  @PrimaryColumn({ type: 'bigint', unsigned: true, transformer: new BigintTransformer() })
  @Generated('increment')
  id!: number;

  @Index()
  @Column({ type: 'bigint', unsigned: true, transformer: new BigintTransformer() })
  postId!: number;

  @Column({ type: 'text', default: '' })
  content = '';

  @Column({ type: 'jsonb', default: '[]' })
  contentJson: any[] = [];

  @Index()
  @Column({ type: 'varchar', length: 64 })
  accountName!: string;

  @Column({ type: 'varchar', length: 64 })
  authorName!: string;
}
