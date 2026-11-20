import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 单日投降扣分上限（当日第 N 次投降扣 N 分） */
export const MAX_SURRENDER_PENALTY = 10;

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

  @Column('timestamp', { nullable: true })
  lastWinAt?: Date; // 最近一次获胜时间（每日首胜判定用，仅胜局更新）

  // --- 防小号刷分字段 ---

  @Column('int', { default: 5 })
  probationGames = 5; // 考察期剩余场数，0=通过

  @Column({ type: 'varchar', length: 64, default: '' })
  lastOpponent = ''; // 上一局对手 accountName

  @Column('int', { default: 0 })
  sameOpponentStreak = 0; // 同对手连胜计数

  @Column({ type: 'text', default: '[]' })
  uniqueOpponents = '[]'; // 历史对手 JSON 数组

  // --- 投降惩罚（当日第 N 次投降扣 N 分，次日重置）---

  @Column('int', { default: 0 })
  surrendersToday = 0; // 当日已投降次数

  @Column({ type: 'varchar', length: 32, default: '' })
  lastSurrenderDate = ''; // 上次投降所在日期（用于跨天重置计数）

  // ---

  win() {
    this.wins++;
    this.totalDuels++;
    this.winStreak++;
    if (this.winStreak > this.bestStreak) {
      this.bestStreak = this.winStreak;
    }
    this.lastDuelAt = new Date();
    this.lastWinAt = new Date(); // 每日首胜依据：记录本次获胜时间
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

  /**
   * 记录一次「当日投降」，返回本次应扣分数。
   * 规则：同一天内第 N 次投降扣 N 分（1、2、3…），上限 MAX_SURRENDER_PENALTY；跨天重置为 -1。
   */
  registerSurrender(): number {
    const today = new Date().toDateString();
    if (this.lastSurrenderDate !== today) {
      this.lastSurrenderDate = today;
      this.surrendersToday = 0;
    }
    this.surrendersToday++;
    return Math.min(this.surrendersToday, MAX_SURRENDER_PENALTY);
  }

  /** 下一次投降将扣的分数（用于提示） */
  get nextSurrenderPenalty(): number {
    const today = new Date().toDateString();
    const count = this.lastSurrenderDate === today ? this.surrendersToday : 0;
    return Math.min(count + 1, MAX_SURRENDER_PENALTY);
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
