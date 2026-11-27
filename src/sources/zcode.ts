import { join } from 'node:path'
import type { SourceResult } from '../aggregate'
import { zcodeWorker } from './zcode-db'
import { listRoots } from './roots'
import { readSqliteSource, sqlitePaths } from './sqlite-reader'
import type { SqliteReaderOptions } from './sqlite-reader'

export function readZcode(options: SqliteReaderOptions): Promise<SourceResult> {
  return readSqliteSource(options, {
    tool: 'zcode',
    label: 'ZCode',
    worker: zcodeWorker,
    paths: async () => {
      const roots = await listRoots(
        (options.env ?? process.env)['ZCODE_HOME'],
        [join(options.home, '.zcode')],
        options.home,
      )
      return sqlitePaths(roots.map((root) => join(root, 'cli/db/db.sqlite')))
    },
  })
}
