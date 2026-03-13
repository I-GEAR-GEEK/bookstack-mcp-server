/**
 * Logger utility using console (compatible with Node.js and Cloudflare Workers)
 */
export class Logger {
  private static instance: Logger;
  private level: string;

  private constructor() {
    this.level = process.env.LOG_LEVEL || 'info';
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(msgLevel: string): boolean {
    const levels = ['error', 'warn', 'info', 'debug'];
    return levels.indexOf(msgLevel) <= levels.indexOf(this.level);
  }

  private format(level: string, message: string, meta?: any): string {
    const ts = new Date().toISOString();
    const metaStr = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} [${level}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: any): void {
    if (this.shouldLog('debug')) console.debug(this.format('debug', message, meta));
  }

  info(message: string, meta?: any): void {
    if (this.shouldLog('info')) console.info(this.format('info', message, meta));
  }

  warn(message: string, meta?: any): void {
    if (this.shouldLog('warn')) console.warn(this.format('warn', message, meta));
  }

  error(message: string, meta?: any): void {
    if (this.shouldLog('error')) console.error(this.format('error', message, meta));
  }

  child(_meta: any): Logger {
    return this;
  }
}

export default Logger;