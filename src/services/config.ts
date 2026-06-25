import { AppContext } from 'nfkit';
import { loadConfig } from '../config';

export class ConfigService {
  constructor(private app: AppContext) {}
  config = loadConfig();
}
