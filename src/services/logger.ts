import { AppContext } from 'nfkit';
import pino from 'pino';
import { ConfigService } from './config';

export class Logger {
  constructor(private ctx: AppContext) {}
  private readonly logger = pino({
    level: this.ctx.get(() => ConfigService).config.getString('LOG_LEVEL'),
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  });

  createLogger(name: string) {
    return this.logger.child({ module: name });
  }
}
