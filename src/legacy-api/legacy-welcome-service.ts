import { Context } from '../app';
import { WelcomeConfigCheck } from '../feats';
import { LegacyApiRecordEntity } from './legacy-api-record.entity';
import { LegacyApiService } from './legacy-api-service';

const WELCOME_RECORD_KEY = 'welcome';

export class LegacyWelcomeService {
  private logger = this.ctx.createLogger('LegacyWelcomeService');

  constructor(private ctx: Context) {
    this.ctx
      .get(() => LegacyApiService)
      .addApiMessageHandler('getwelcome', 'change_settings', async () => {
        const welcome = await this.getWelcomeText();
        return ['get ok', welcome];
      })
      .addApiMessageHandler('welcome', 'change_settings', async (value) => {
        const welcome = await this.setWelcomeText(value);
        return ['welcome ok', welcome || ''];
      });
  }

  async init() {
    this.ctx.middleware(WelcomeConfigCheck, async (event, client, next) => {
      const dbWelcome = await this.getWelcomeFromDatabase();
      if (dbWelcome) {
        event.use(dbWelcome);
      }
      return next();
    });
  }

  async getWelcomeText() {
    const dbWelcome = await this.getWelcomeFromDatabase();
    if (dbWelcome) {
      return dbWelcome;
    }
    return this.ctx.config.getString('WELCOME');
  }

  async setWelcomeText(rawValue: string | boolean | null | undefined) {
    const valueText = this.normalizeWelcome(rawValue);
    const database = this.ctx.database;
    if (!database) {
      return this.ctx.config.getString('WELCOME');
    }

    const repo = database.getRepository(LegacyApiRecordEntity);
    await repo.delete({
      key: WELCOME_RECORD_KEY,
    });

    if (!valueText) {
      this.logger.info('Cleared legacy welcome override');
      return this.ctx.config.getString('WELCOME');
    }

    const record = repo.create({
      key: WELCOME_RECORD_KEY,
      value: valueText,
    });
    await repo.save(record);
    this.logger.info({ welcome: valueText }, 'Updated legacy welcome override');
    return valueText;
  }

  private async getWelcomeFromDatabase() {
    const database = this.ctx.database;
    if (!database) {
      return undefined;
    }
    const repo = database.getRepository(LegacyApiRecordEntity);
    const record = await repo.findOne({
      where: {
        key: WELCOME_RECORD_KEY,
      },
    });
    const text = (record?.value || '').trim();
    return text || undefined;
  }

  private normalizeWelcome(rawValue: string | boolean | null | undefined) {
    if (rawValue === false || rawValue == null) {
      return '';
    }
    const valueText = String(rawValue).trim();
    if (!valueText || valueText.toLowerCase() === 'false') {
      return '';
    }
    return valueText;
  }
}
