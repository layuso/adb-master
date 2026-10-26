import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { logger } from '../utils/logger';

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_FRAME_BYTES = 20 * 1024 * 1024;
export type CaptureMode = 'manual' | 'eink' | 'standard';
const EINK_INTERVAL_MS = 5000;
const CAPTURE_INTERVAL_MIN_MS = 67;
const CAPTURE_TIMEOUT_MS = 15000;

/**
 * E-ink-safe screen capture. Executes one screenshot per capture.
 * Critically, no remote Android shell loop is created, so disconnects
 * cannot leave persistent screencap producers behind.
 */
export class ScreenStream extends EventEmitter {
  private proc: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private mode: CaptureMode = 'eink';
  private intervalMs = EINK_INTERVAL_MS;
  private serial = '';

  start(serial: string, mode: CaptureMode = 'eink', fps = 1): void {
    if (this.running) return;
    this.serial = serial;
    this.mode = mode;
    this.intervalMs = mode === 'eink' ? EINK_INTERVAL_MS : Math.max(CAPTURE_INTERVAL_MIN_MS, Math.ceil(1000 / Math.max(1, Math.min(15, fps))));
    this.running = true;
    this.capture(serial);
  }

  refresh(): void {
    if (!this.running || this.mode !== 'manual' || this.proc) return;
    this.capture(this.serial);
  }

  private capture(serial: string): void {
    if (!this.running || this.proc) return;
    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const proc = spawn(config.adbPath, ['-s', serial, 'exec-out', 'screencap', '-p']);
    this.proc = proc;

    const done = (code: number | null, error?: Error): void => {
      if (finished) return;
      finished = true;
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = null;
      this.proc = null;
      if (!this.running) return;
      if (error) {
        logger.warn(`Screen capture failed for ${serial}: ${error.message}`);
        this.running = false;
        this.emit('error', error);
        return;
      }
      if (code === 0) {
        const png = Buffer.concat(chunks);
        if (png.subarray(0, 8).equals(PNG_MAGIC)) {
          this.emit('frame', png);
        } else {
          logger.warn(`Screen capture returned invalid PNG for ${serial}`);
        }
      } else {
        logger.warn(`Screen capture exited with code ${code} for ${serial}`);
      }
      // Serialized capture: never overlap, even when capture takes longer than target FPS.
      if (this.running && this.mode !== 'manual') {
        const delay = Math.max(0, this.intervalMs - (Date.now() - startedAt));
        this.timer = setTimeout(() => { this.timer = null; this.capture(serial); }, delay);
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        proc.kill('SIGKILL');
        done(null, new Error('Screen capture exceeded 20MB limit'));
      } else {
        chunks.push(chunk);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => logger.debug(`Screen capture: ${chunk.toString().trim()}`));
    proc.on('error', (error: Error) => done(null, error));
    proc.on('close', (code) => done(code));
    this.timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      done(null, new Error('Screen capture timed out after 15 seconds'));
    }, CAPTURE_TIMEOUT_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.timeout) clearTimeout(this.timeout);
    this.timer = null;
    this.timeout = null;
    if (this.proc) this.proc.kill('SIGKILL');
    this.proc = null;
    this.removeAllListeners();
  }

  isRunning(): boolean { return this.running; }
}
