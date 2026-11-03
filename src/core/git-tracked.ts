import { execFile } from 'child_process'
import { promisify } from 'util'
import { gitEnv } from './git-env'
import { localGitCommand } from './wsl-git'

const run = promisify(execFile)

/**
 * Does git track `file` in the repository holding `folder`? `true` / `false`, or `'unknown'` when
 * it could not be told (git missing, a broken repository): callers that would DELETE a file treat
 * unknown like tracked and ask first, because a deletion git sees is a change in the user's repo.
 * A folder that is not a repository at all is a definite `false`.
 */
export async function gitTracksFile(folder: string, file: string): Promise<boolean | 'unknown'> {
  try {
    const cmd = localGitCommand(folder, ['ls-files', '--error-unmatch', '--', file], {
      env: gitEnv(),
      timeout: 10_000
    })
    await run(cmd.file, cmd.args, cmd.options)
    return true
  } catch (e) {
    const err = e as { code?: unknown; stderr?: string }
    if (err.code === 1) return false // ran in a repository; the path is not tracked
    if (/not a git repository/i.test(err.stderr ?? '')) return false
    return 'unknown'
  }
}
