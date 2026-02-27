import { Collection, Db, MongoClient } from 'mongodb';
import { RuntimeConfig } from './env';
import { GitHubUserProfile } from './githubAuth';
import { HeartbeatPayload } from './heartbeat';

interface StoredUser extends GitHubUserProfile {
  createdAt: Date;
  updatedAt: Date;
}

interface StoredHeartbeat {
  githubUserId: number;
  githubLogin: string;
  timestamp: Date;
  payload: HeartbeatPayload;
  createdAt: Date;
}

export class MongoStore {
  private client: MongoClient | undefined;
  private db: Db | undefined;
  private users: Collection<StoredUser> | undefined;
  private heartbeats: Collection<StoredHeartbeat> | undefined;
  private connectPromise: Promise<void> | undefined;
  private warned: boolean = false;

  constructor(private readonly getConfig: () => RuntimeConfig) {}

  async upsertUser(user: GitHubUserProfile): Promise<void> {
    const users = await this.getUsersCollection();
    if (!users) {
      return;
    }

    const now = new Date();
    await users.updateOne(
      { githubUserId: user.githubUserId },
      {
        $set: {
          githubUserId: user.githubUserId,
          githubLogin: user.githubLogin,
          email: user.email ?? null,
          name: user.name ?? null,
          avatarUrl: user.avatarUrl ?? null,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  async saveHeartbeat(payload: HeartbeatPayload): Promise<void> {
    if (!payload.user) {
      return;
    }

    const heartbeats = await this.getHeartbeatCollection();
    if (!heartbeats) {
      return;
    }

    await heartbeats.insertOne({
      githubUserId: payload.user.githubUserId,
      githubLogin: payload.user.githubLogin,
      timestamp: new Date(payload.timestamp * 1000),
      payload,
      createdAt: new Date(),
    });
  }

  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
    this.client = undefined;
    this.db = undefined;
    this.users = undefined;
    this.heartbeats = undefined;
    this.connectPromise = undefined;
  }

  private async getUsersCollection(): Promise<Collection<StoredUser> | undefined> {
    const db = await this.getDb();
    if (!db) {
      return undefined;
    }
    if (!this.users) {
      this.users = db.collection<StoredUser>('users');
    }
    return this.users;
  }

  private async getHeartbeatCollection(): Promise<Collection<StoredHeartbeat> | undefined> {
    const db = await this.getDb();
    if (!db) {
      return undefined;
    }
    if (!this.heartbeats) {
      this.heartbeats = db.collection<StoredHeartbeat>('heartbeats');
    }
    return this.heartbeats;
  }

  private async getDb(): Promise<Db | undefined> {
    if (this.db) {
      return this.db;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = undefined;
      });
    }

    await this.connectPromise;
    return this.db;
  }

  private async connect(): Promise<void> {
    const config = this.getConfig();
    if (!config.mongodbUri) {
      this.warnOnce(`BuildersHQ MongoDB disabled: missing MONGODB_URI in ${config.envPath}`);
      return;
    }

    try {
      this.client = new MongoClient(config.mongodbUri);
      await this.client.connect();
      this.db = this.client.db(config.mongodbDb);

      const users = this.db.collection<StoredUser>('users');
      const heartbeats = this.db.collection<StoredHeartbeat>('heartbeats');

      await Promise.all([
        users.createIndex({ githubUserId: 1 }, { unique: true, name: 'user_github_id' }),
        users.createIndex({ githubLogin: 1 }, { unique: true, name: 'user_github_login' }),
        heartbeats.createIndex({ githubUserId: 1, timestamp: -1 }, { name: 'heartbeat_user_timestamp' }),
        heartbeats.createIndex({ createdAt: -1 }, { name: 'heartbeat_created' }),
      ]);
    } catch (error) {
      this.warnOnce(
        `BuildersHQ MongoDB connection failed (${config.mongodbDb}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.dispose();
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    console.warn(message);
  }
}
