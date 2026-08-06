import { BaseTimeEntity, BigintTransformer } from '../../utility';
import { Column, Entity, Generated, Index, PrimaryColumn } from 'typeorm';

export type ForumSection = 'casual' | 'feedback' | 'deck' | 'qa';

@Entity('community_post')
export class CommunityPostEntity extends BaseTimeEntity {
  @PrimaryColumn({ type: 'bigint', unsigned: true, transformer: new BigintTransformer() })
  @Generated('increment')
  id!: number;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  section!: ForumSection;

  @Column({ type: 'varchar', length: 60 })
  title!: string;

  @Column({ type: 'text', default: '' })
  content = '';

  @Column({ type: 'jsonb', default: '[]' })
  contentJson: any[] = [];

  @Index()
  @Column({ type: 'varchar', length: 64 })
  accountName!: string;

  @Column({ type: 'varchar', length: 64 })
  authorName!: string;

  @Column('int', { default: 0 })
  likeCount = 0;

  @Column('int', { default: 0 })
  replyCount = 0;

  @Column({ type: 'boolean', default: false })
  isPinned = false;

  @Column('int', { default: 0 })
  viewCount = 0;

  @Column({ type: 'varchar', length: 100, default: '' })
  tags = ''; // 逗号分隔标签，如 '构筑,已解决'

  @Column({ type: 'timestamp', nullable: true })
  @Index()
  lastReplyAt?: Date; // 最后回复时间，用于「最新回复」排序
}
