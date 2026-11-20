import { Server as NetServer, Socket, createServer } from 'node:net';
import { Context } from '../../../app';
import { ClientHandler } from '../../client-handler';
import { TcpClient } from './client';

export class TcpServer {
  private server?: NetServer;
  private logger = this.ctx.createLogger('TcpServer');

  constructor(private ctx: Context) {}

  async init(): Promise<void> {
    const portNum = this.ctx.config.getInt('PORT');
    if (!portNum) {
      this.logger.info('PORT not configured, TCP server will not start');
      return;
    }

    const host = this.ctx.config.getString('HOST');

    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(portNum, host, () => {
        this.logger.info({ host, port: portNum }, 'TCP server listening');
        resolve();
      });

      this.server!.on('error', (err) => {
        this.logger.error({ err }, 'TCP server error');
        reject(err);
      });
    });
  }

  private handleConnection(socket: Socket): void {
    // PATCH(白神服) 2026-11-01: 半开连接检测
    //   客户端被强杀 / 手机切网时不会发 FIN，服务器会一直把它当成「还在房间里」→
    //   重连进来就变成「两个自己」。开 TCP keepalive 让内核尽快发现死连接（配合
    //   /etc/sysctl.d/99-siro-net.conf 的 tcp_keepalive_intvl / probes）。
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 20000);
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET') {
        this.logger.debug(
          {
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
          },
          'TCP socket reset by peer',
        );
        return;
      }

      this.logger.warn(
        {
          err,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        },
        'TCP socket error',
      );
    });

    const client = new TcpClient(this.ctx, socket);
    const handler = this.ctx.get(() => ClientHandler);
    handler.handleClient(client).catch((err) => {
      this.logger.error({ err }, 'Error handling client');
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.logger.info('TCP server closed');
        resolve();
      });
    });
  }
}
