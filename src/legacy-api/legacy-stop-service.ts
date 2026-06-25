import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { LegacyApiRecordEntity } from './legacy-api-record.entity';
import { LegacyApiService } from './legacy-api-service';

const STOP_RECORD_KEY = 'stop';

export class LegacyStopService {
  private logger = this.ctx.createLogger('LegacyStopService');
  private stopText?: string;

  constructor(private ctx: Context) {
    this.ctx
      .get(() => LegacyApiService)
      .addApiMessageHandler('stop', 'stop', async (value) => {
        const stop = await this.setStopText(value);
        return ['stop ok', stop || false];
      });
  }

  async init() {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!this.stopText) {
        return next();
      }
      return client.die(this.stopText, ChatColor.RED);
    });

    const text = await this.loadStopTextFromDatabase();
    this.stopText = text;
    if (text) {
      this.logger.warn(
        { stop: text },
        'Server stop mode restored from database',
      );
    }
  }

  getStopText() {
    return this.stopText;
  }

  async setStopText(rawValue: string | boolean | null | undefined) {
    const nextText = this.normalizeStopText(rawValue);
    this.stopText = nextText || undefined;

    const database = this.ctx.database;
    if (!database) {
      return this.stopText;
    }

    const repo = database.getRepository(LegacyApiRecordEntity);
    await repo.delete({
      key: STOP_RECORD_KEY,
    });

    if (!nextText) {
      this.logger.info('Cleared stop mode');
      return undefined;
    }

    const record = repo.create({
      key: STOP_RECORD_KEY,
      value: nextText,
    });
    await repo.save(record);
    this.logger.info({ stop: nextText }, 'Set stop mode');
    return nextText;
  }

  private async loadStopTextFromDatabase() {
    const database = this.ctx.database;
    if (!database) {
      return undefined;
    }
    const repo = database.getRepository(LegacyApiRecordEntity);
    const record = await repo.findOne({
      where: {
        key: STOP_RECORD_KEY,
      },
    });
    const value = (record?.value || '').trim();
    return value || undefined;
  }

  private normalizeStopText(rawValue: string | boolean | null | undefined) {
    if (rawValue === false || rawValue == null) {
      return '';
    }
    const text = String(rawValue).trim();
    if (!text || text.toLowerCase() === 'false') {
      return '';
    }
    return text;
  }
}
