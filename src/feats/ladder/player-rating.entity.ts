import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('player_rating')
export class PlayerRating {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  accountName!: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  displayName!: string;

  @Index()
  @Column('int', { default: 1000 })
  rating = 1000;

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

  win() {
    this.wins++;
    this.totalDuels++;
    this.winStreak++;
    if (this.winStreak > this.bestStreak) {
      this.bestStreak = this.winStreak;
    }
    this.lastDuelAt = new Date();
  }

  lose() {
    this.losses++;
    this.totalDuels++;
    this.winStreak = 0;
    this.lastDuelAt = new Date();
  }

  draw() {
    this.draws++;
    this.totalDuels++;
    this.winStreak = 0;
    this.lastDuelAt = new Date();
  }

  get winRate(): string {
    if (this.totalDuels === 0) return '0%';
    return ((this.wins / this.totalDuels) * 100).toFixed(1) + '%';
  }
}
