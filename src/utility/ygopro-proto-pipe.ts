import { Observable, OperatorFunction, EMPTY, from } from 'rxjs';
import { scan, mergeMap } from 'rxjs/operators';
import { YGOProCtos, YGOProStoc } from 'ygopro-msg-encode';

export type YGOProPipeOptions = {
  maxFrameBytes?: number;
  maxBufferBytes?: number;
  onError?: (err: Error) => any;
};

type ScanState<T> = {
  acc: Buffer;
  out: T[]; // 本轮解析出来的消息
  skipBytes?: number;
};

export const YGOProProtoPipe = <
  R extends typeof YGOProCtos | typeof YGOProStoc,
>(
  registry: R,
  opts: YGOProPipeOptions = {},
): OperatorFunction<
  Buffer<ArrayBufferLike>,
  ReturnType<R['getInstanceFromPayload']>
> => {
  const maxFrameBytes = opts.maxFrameBytes ?? 64 * 1024;
  const maxBufferBytes = opts.maxBufferBytes ?? 4 * 1024 * 1024;

  return (source: Observable<Buffer<ArrayBufferLike>>) =>
    source.pipe(
      scan<
        Buffer<ArrayBufferLike>,
        ScanState<ReturnType<R['getInstanceFromPayload']>>
      >(
        (state, chunk) => {
          let acc =
            !chunk || chunk.length === 0
              ? state.acc
              : state.acc.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([state.acc, chunk]);

          // 输出先清空，本轮重新填
          const out: ReturnType<R['getInstanceFromPayload']>[] = [];

          if (acc.length > maxBufferBytes) {
            opts.onError?.(
              new Error(
                'Buffer overflow: accumulated bytes exceed maxBufferBytes',
              ),
            );
            // reset
            return { acc: Buffer.alloc(0), out };
          }

          while (acc.length >= 3) {
            if (state.skipBytes && state.skipBytes > 0) {
              if (acc.length < state.skipBytes) {
                return {
                  acc: Buffer.alloc(0),
                  out,
                  skipBytes: state.skipBytes - acc.length,
                };
              } else {
                acc = acc.subarray(state.skipBytes);
                state.skipBytes = 0;
                continue;
              }
            }

            const len = acc.readUInt16LE(0);
            if (len < 1) {
              acc = acc.subarray(2);
              continue;
            }

            const total = 2 + len;
            if (total > maxFrameBytes) {
              opts.onError?.(new Error('Frame size exceeds maxFrameBytes'));
              state.skipBytes = (state.skipBytes ?? 0) + total;
              continue;
            }

            if (acc.length < total) break;

            const frame = acc.subarray(0, total);
            acc = acc.subarray(total);

            try {
              const inst = registry.getInstanceFromPayload(frame);
              if (inst)
                out.push(inst as ReturnType<R['getInstanceFromPayload']>);
            } catch (err) {
              opts.onError?.(err as Error);
              // skip invalid frame
            }
          }

          return { acc, out };
        },
        { acc: Buffer.alloc(0), out: [] },
      ),
      // 把每轮的 out 数组摊平成逐条 emit
      mergeMap((s) => (s.out.length ? from(s.out) : EMPTY)),
    );
};
