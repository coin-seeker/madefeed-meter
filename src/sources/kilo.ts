import { join } from 'node:path'
import type { SourceResult } from '../aggregate'
import { kiloWorker } from './kilo-db'
import { listRoots } from './roots'
import { readSqliteSource, sqlitePaths } from './sqlite-reader'
import type { SqliteReaderOptions } from './sqlite-reader'

export function readKilo(options: SqliteReaderOptions): Promise<SourceResult> {
  return readSqliteSource(options, {
    tool: 'kilo',
    label: 'Kilo Code',
    worker: kiloWorker,
    paths: async () => {
      const roots = await listRoots(
        (options.env ?? process.env)['KILO_DATA_DIR'],
        [join(options.home, '.local/share/kilo')],
        options.home,
      )
      return sqlitePaths(roots.map((root) => join(root, 'kilo.db')))
    },
  })
}
