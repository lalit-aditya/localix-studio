import { sql, type Kysely } from 'kysely'

/**
 * Nothing reads or writes `projects.folder_identity`: a project whose folder is gone is deleted
 * rather than looked for (`features/projects/folder-gone.ts`), so the column goes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE projects DROP COLUMN folder_identity`.execute(db)
}
