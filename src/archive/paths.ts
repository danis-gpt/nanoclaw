import path from 'path';

import { DATA_DIR } from '../config.js';

export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
export const ARCHIVE_RAW_DIR = path.join(ARCHIVE_DIR, 'raw');
export const ARCHIVE_DB_PATH = path.join(ARCHIVE_DIR, 'archive.db');
