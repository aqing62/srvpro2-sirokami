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
}
