import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

// Ensure logs directory exists
const logDir = path.dirname(config.logging.file);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Logger configuration with Winston
 * Outputs to console (colored) and file (JSON)
 */
export const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true })
  ),
  transports: [
    // Console output with colors
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level}: ${message}`;
        })
      ),
    }),
    // File output in JSON format for parsing
    new winston.transports.File({
      filename: config.logging.file,
      format: winston.format.combine(
        winston.format.json()
      ),
      maxsize: 10 * 1024 * 1024, // 10MB per file
      maxFiles: 5,
    }),
    // Separate error log
    new winston.transports.File({
      filename: config.logging.file.replace('.log', '-error.log'),
      level: 'error',
      format: winston.format.combine(
        winston.format.json()
      ),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});
