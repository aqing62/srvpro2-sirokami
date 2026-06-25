import { AppContext } from 'nfkit';
import { FileResourceService } from '../file-resource';
import { Logger } from './logger';
import { UserService } from '../feats/login';

type PermissionSet = Record<string, boolean>;

type UserPermissions = string | PermissionSet;

type PermissionExamples = Record<string, PermissionSet>;

const EMPTY_USERS_FILE = {
  permission_examples: {} as PermissionExamples,
  users: {} as Record<string, unknown>,
};

export class LegacyApiAuthService {
  private logger = this.ctx
    .get(() => Logger)
    .createLogger('LegacyApiAuthService');
  private fileResource = this.ctx.get(() => FileResourceService);
  private userService = this.ctx.get(() => UserService);

  constructor(private ctx: AppContext) {}

  async auth(
    name: string,
    pass: string,
    permissionRequired: string,
    action = 'unknown',
  ) {
    // Look up user from database (with file fallback)
    const user = await this.userService.findByName(name);

    if (!user) {
      this.logger.info(
        {
          user: name,
          permissionRequired,
          action,
          result: 'unknown_user',
        },
        'Legacy API auth',
      );
      return false;
    }

    if (user.password !== pass) {
      this.logger.info(
        {
          user: name,
          permissionRequired,
          action,
          result: 'bad_password',
        },
        'Legacy API auth',
      );
      return false;
    }

    if (!user.enabled) {
      this.logger.info(
        {
          user: name,
          permissionRequired,
          action,
          result: 'disabled_user',
        },
        'Legacy API auth',
      );
      return false;
    }

    const permissionExamples = await this.loadPermissionExamples();
    const permission = this.resolvePermissionSet(
      permissionExamples,
      user.permissions || '',
    );
    const allowed = !!permission?.[permissionRequired];
    this.logger.info(
      {
        user: name,
        permissionRequired,
        action,
        result: allowed ? 'ok' : 'permission_denied',
      },
      'Legacy API auth',
    );
    return allowed;
  }

  private async loadPermissionExamples(): Promise<PermissionExamples> {
    try {
      const usersData = await this.fileResource.getDataOrEmptyAsync(
        'users',
        EMPTY_USERS_FILE,
        { forceRead: true },
      );
      return (
        (usersData as any).permission_examples || {}
      );
    } catch {
      return {};
    }
  }

  private resolvePermissionSet(
    permissionExamples: PermissionExamples,
    permissions: UserPermissions,
  ): PermissionSet | undefined {
    if (typeof permissions === 'string') {
      return permissionExamples[permissions];
    }
    if (permissions && typeof permissions === 'object') {
      return permissions;
    }
    return undefined;
  }
}
