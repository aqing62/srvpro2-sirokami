import * as fs from 'node:fs';
import { DataSource, Repository } from 'typeorm';
import { Context } from '../../app';
import { User } from './user.entity';
import { TypeormLoader } from '../../services/typeorm';

export interface UserEntry {
  password: string;
  enabled?: boolean;
  permissions?: string;
  displayName?: string;
}

export class UserService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private typeormLoader = this.ctx.get(() => TypeormLoader);
  private usersPath = './data/admin_user.json';
  private migrated = false;

  constructor(private ctx: Context) {}

  /**
   * Auto-migrate existing JSON users to database on startup.
   */
  async init() {
    await this.ensureMigration();
  }

  /**
   * Get the TypeORM repository if database is available.
   */
  private get repo(): Repository<User> | undefined {
    const ds = this.typeormLoader.database;
    if (!ds) return undefined;
    return ds.getRepository(User);
  }

  /**
   * Ensure existing JSON users are migrated to the database.
   * Runs once per process lifetime.
   */
  async ensureMigration(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;

    const repo = this.repo;
    if (!repo) return;

    const fileUsers = this.loadUsersFromFile();
    if (!fileUsers || Object.keys(fileUsers).length === 0) return;

    let imported = 0;
    for (const [accountName, entry] of Object.entries(fileUsers)) {
      try {
        const existing = await repo.findOneBy({ accountName });
        if (!existing) {
          const user = new User();
          user.accountName = accountName;
          user.password = entry.password;
          user.enabled = entry.enabled !== false;
          user.permissions = entry.permissions || '';
          user.displayName = entry.displayName;
          await repo.save(user);
          imported++;
        }
      } catch (err) {
        this.logger.warn(
          { accountName, error: (err as Error).message },
          'Failed to migrate user from file to database',
        );
      }
    }

    if (imported > 0) {
      this.logger.info(
        { imported, total: Object.keys(fileUsers).length },
        'Migrated users from JSON file to database',
      );
    }
  }

  /**
   * Find a user by account name. Returns undefined if not found.
   */
  async findByName(accountName: string): Promise<UserEntry | undefined> {
    await this.ensureMigration();

    const repo = this.repo;
    if (repo) {
      try {
        const user = await repo.findOneBy({ accountName });
        if (user) {
          return {
            password: user.password,
            enabled: user.enabled,
            permissions: user.permissions,
            displayName: user.displayName,
          };
        }
        return undefined;
      } catch (err) {
        this.logger.warn(
          { accountName, error: (err as Error).message },
          'DB lookup failed, falling back to file',
        );
      }
    }

    // Fallback to file
    const users = this.loadUsersFromFile();
    return users?.[accountName];
  }

  /**
   * Create a new user in the database (or file if DB is unavailable).
   */
  async createUser(
    accountName: string,
    password: string,
    displayName?: string,
    permissions = '',
  ): Promise<UserEntry> {
    await this.ensureMigration();

    const entry: UserEntry = {
      password,
      enabled: true,
      permissions,
      displayName,
    };

    const repo = this.repo;
    if (repo) {
      try {
        const user = new User();
        user.accountName = accountName;
        user.password = password;
        user.enabled = true;
        user.permissions = permissions;
        user.displayName = displayName;
        await repo.save(user);
        return entry;
      } catch (err) {
        this.logger.warn(
          { accountName, error: (err as Error).message },
          'DB create failed, falling back to file',
        );
      }
    }

    // Fallback to file
    const users = this.loadUsersFromFile() || {};
    users[accountName] = entry;
    this.saveUsersToFile(users);
    return entry;
  }

  /**
   * Update an existing user's displayName.
   */
  async updateDisplayName(
    accountName: string,
    displayName: string,
  ): Promise<void> {
    const repo = this.repo;
    if (repo) {
      try {
        await repo.update({ accountName }, { displayName });
        return;
      } catch (err) {
        this.logger.warn(
          { accountName, error: (err as Error).message },
          'DB update failed, falling back to file',
        );
      }
    }

    // Fallback to file
    const users = this.loadUsersFromFile();
    if (users?.[accountName]) {
      users[accountName].displayName = displayName;
      this.saveUsersToFile(users);
    }
  }

  private loadUsersFromFile(): Record<string, UserEntry> | undefined {
    try {
      const data = fs.readFileSync(this.usersPath, 'utf-8');
      const parsed = JSON.parse(data);
      return parsed.users || {};
    } catch {
      return undefined;
    }
  }

  private saveUsersToFile(users: Record<string, UserEntry>): void {
    try {
      const dir = './data';
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      let parsed: any = {};
      try {
        const data = fs.readFileSync(this.usersPath, 'utf-8');
        parsed = JSON.parse(data);
      } catch {
        // file doesn't exist yet, use empty
      }
      parsed.users = users;
      fs.writeFileSync(this.usersPath, JSON.stringify(parsed, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'Failed to save users to file',
      );
    }
  }
}
