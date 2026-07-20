import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('player_rating')
export class PlayerRating {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  accountName!: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  displayName!: string;

  @Index()
  @Column('int', { default: 0 })
  rating = 0;

  @Column('int', { default: 0 })
  wins = 0;

  @Column('int', { default: 0 })
  losses = 0;

  @Column('int', { default: 0 })
  draws = 0;

  @Column('int', { default: 0 })
  winStreak = 0;

  @Column('int', { default: 0 })
  bestStreak = 0;

  @Column('int', { default: 0 })
  totalDuels = 0;

  @Column('timestamp', { nullable: true })
  lastDuelAt?: Date;

  // --- 防小号刷分字段 ---

  @Column('int', { default: 5 })
  probationGames = 5; // 考察期剩余场数，0=通过

  @Column({ type: 'varchar', length: 64, default: '' })
  lastOpponent = ''; // 上一局对手 accountName

  @Column('int', { default: 0 })
  sameOpponentStreak = 0; // 同对手连胜计数

  @Column({ type: 'text', default: '[]' })
  uniqueOpponents = '[]'; // 历史对手 JSON 数组

  // ---

  win() {
    this.wins++;
    this.totalDuels++;
    this.winStreak++;
    if (this.winStreak > this.bestStreak) {
      this.bestStreak = this.winStreak;
    }
    this.lastDuelAt = new Date();
    if (this.probationGames > 0) this.probationGames--;
  }

  lose() {
    this.losses++;
    this.totalDuels++;
    this.winStreak = 0;
    this.lastDuelAt = new Date();
    if (this.probationGames > 0) this.probationGames--;
  }

  draw() {
    this.draws++;
    this.totalDuels++;
    this.winStreak = 0;
    this.lastDuelAt = new Date();
    if (this.probationGames > 0) this.probationGames--;
  }

  addOpponent(accountName: string) {
    const list: string[] = JSON.parse(this.uniqueOpponents || '[]');
    if (!list.includes(accountName)) {
      list.push(accountName);
      this.uniqueOpponents = JSON.stringify(list);
    }
  }

  get uniqueOpponentCount(): number {
    try {
      return JSON.parse(this.uniqueOpponents || '[]').length;
    } catch {
      return 0;
    }
  }

  get winRate(): string {
    if (this.totalDuels === 0) return '0%';
    return ((this.wins / this.totalDuels) * 100).toFixed(1) + '%';
  }
}
