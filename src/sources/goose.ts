import { join } from 'node:path'
import type { SourceResult } from '../aggregate'
import { gooseWorker } from './goose-db'
import { readSqliteSource, sqlitePaths } from './sqlite-reader'
import type { SqliteReaderOptions } from './sqlite-reader'

export function readGoose(options: SqliteReaderOptions): Promise<SourceResult> {
  return readSqliteSource(options, {
    tool: 'goose',
    label: 'Goose',
    worker: gooseWorker,
    paths: () => {
      const override = (options.env ?? process.env)['GOOSE_PATH_ROOT']?.trim()
      const root =
        override === '~'
          ? options.home
          : override?.startsWith('~/')
            ? join(options.home, override.slice(2))
            : override
      return sqlitePaths(
        root
          ? [join(root, 'data/sessions/sessions.db')]
          : [
              join(options.home, '.local/share/goose/sessions/sessions.db'),
              join(
                options.home,
                'Library/Application Support/goose/sessions/sessions.db',
              ),
              join(
                options.home,
                '.local/share/Block/goose/sessions/sessions.db',
              ),
            ],
      )
    },
  })
}
