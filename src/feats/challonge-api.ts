import axios, { AxiosInstance } from 'axios';
import PQueue from 'p-queue';

export interface Match {
  id: number;
  state: 'pending' | 'open' | 'complete';
  player1_id: number;
  player2_id: number;
  winner_id?: number | 'tie';
  scores_csv?: string;
}

export interface MatchWrapper {
  match: Match;
}

export interface Participant {
  id: number;
  name: string;
  deckbuf?: string;
}

export interface ParticipantWrapper {
  participant: Participant;
}

export interface Tournament {
  id: number;
  participants: ParticipantWrapper[];
  matches: MatchWrapper[];
}

export interface TournamentWrapper {
  tournament: Tournament;
}

export interface MatchPost {
  scores_csv: string;
  winner_id?: number | 'tie';
}

export interface ChallongeConfig {
  api_key: string;
  tournament_id: string;
  cache_ttl: number;
  challonge_url: string;
}

export type ChallongeLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const NOOP_LOGGER: ChallongeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class Challonge {
  constructor(
    private config: ChallongeConfig,
    private http: AxiosInstance = axios.create(),
    private logger: ChallongeLogger = NOOP_LOGGER,
  ) {}

  private queue = new PQueue({ concurrency: 1 });
  private previous?: Tournament;
  private previousTime = 0;

  private get tournamentEndpoint() {
    const root = this.config.challonge_url.replace(/\/+$/, '');
    return `${root}/v1/tournaments/${this.config.tournament_id}.json`;
  }

  private async getTournamentProcess(noCache = false) {
    const now = Date.now();
    if (
      !noCache &&
      this.previous &&
      now - this.previousTime <= this.config.cache_ttl
    ) {
      return this.previous;
    }
    try {
      const {
        data: { tournament },
      } = await this.http.get<TournamentWrapper>(this.tournamentEndpoint, {
        params: {
          api_key: this.config.api_key,
          include_participants: 1,
          include_matches: 1,
        },
        timeout: 5000,
      });
      this.previous = tournament;
      this.previousTime = Date.now();
      return tournament;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to get tournament ${this.config.tournament_id}: ${String(e)}`,
      );
      return undefined;
    }
  }

  async getTournament(noCache = false) {
    if (noCache) {
      return this.getTournamentProcess(noCache);
    }
    return this.queue.add(() => this.getTournamentProcess(noCache));
  }

  async putScore(matchId: number, match: MatchPost, retried = 0) {
    try {
      const root = this.config.challonge_url.replace(/\/+$/, '');
      await this.http.put(
        `${root}/v1/tournaments/${this.config.tournament_id}/matches/${matchId}.json`,
        {
          api_key: this.config.api_key,
          match,
        },
      );
      this.previous = undefined;
      this.previousTime = 0;
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to put score for match ${matchId}: ${String(e)}`,
      );
      if (retried < 5) {
        this.logger.info(`Retrying match ${matchId}`);
        return this.putScore(matchId, match, retried + 1);
      }
      this.logger.error(
        `Failed to put score for match ${matchId} after 5 retries`,
      );
      return false;
    }
  }

  async clearParticipants() {
    try {
      const root = this.config.challonge_url.replace(/\/+$/, '');
      await this.http.delete(
        `${root}/v1/tournaments/${this.config.tournament_id}/participants/clear.json`,
        {
          params: {
            api_key: this.config.api_key,
          },
          validateStatus: () => true,
        },
      );
      this.previous = undefined;
      this.previousTime = 0;
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to clear participants for tournament ${this.config.tournament_id}: ${String(e)}`,
      );
      return false;
    }
  }

  async uploadParticipants(participants: { name: string; deckbuf?: string }[]) {
    try {
      const root = this.config.challonge_url.replace(/\/+$/, '');
      await this.http.post(
        `${root}/v1/tournaments/${this.config.tournament_id}/participants/bulk_add.json`,
        {
          api_key: this.config.api_key,
          participants,
        },
      );
      this.previous = undefined;
      this.previousTime = 0;
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to upload participants for tournament ${this.config.tournament_id}: ${String(e)}`,
      );
      return false;
    }
  }
}
