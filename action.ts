import { getBooleanInput, getInput, setFailed, setOutput } from '@actions/core'
import { context, getOctokit } from '@actions/github'
import indentString from 'indent-string'
import { readFile } from 'node:fs/promises'

async function action() {
  const { rest } = getOctokit(getInput('token'))
  const tag = context.ref.replace('refs/tags/', '')

  const fetchChangelog = async () => {
    try {
      const { data } = await rest.repos.getContent({
        ...context.repo,
        path: 'changelog.md',
      })

      // @ts-ignore:
      return [data.sha, await readFile('changelog.md', { encoding: 'utf-8' })]
    } catch (err) {
      return [null, '']
    }
  }

  const getLatestRelease = async () => {
    try {
      const data = await rest.repos.getLatestRelease({
        ...context.repo,
      })

      return {
        data: data.data,
        status: data.status,
      }
    } catch (err) {
      return {
        status: 404,
      }
    }
  }

  const { data: latestRelease, status } = await getLatestRelease()

  if (!latestRelease) {
    throw new Error('Failed to fetch latest release.')
  }

  let { data } = await rest.pulls.list({
    ...context.repo,
    per_page: 100,
    sort: 'updated',
    state: 'closed',
    direction: 'desc',
  })

  data = [
    ...data,
    ...(await rest.pulls.list({
      ...context.repo,
      per_page: 100,
      sort: 'updated',
      state: 'closed',
      direction: 'desc',
      page: 2,
    })).data,
  ]

  const year = new Date().getUTCFullYear(),
    month = new Date().getUTCMonth() + 1,
    day = new Date().getUTCDate()

  let changelogBody =
      `## [${tag}](https://github.com/${context.repo.owner}/${context.repo.repo}/releases/tag/${tag})\n`,
    releaseBody = `### ${tag} / ${year}.${month < 10 ? `0${month}` : month}.${
      day < 10 ? `0${day}` : day
    }\n`

  const style = getInput('style').split(', ')

  data.sort((a, b) => {
    const x = a.title.toLowerCase(),
      y = b.title.toLowerCase()

    if (x < y) {
      return -1
    }

    if (x > y) {
      return 1
    }

    return 0
  })
  
  for (const { user, merged_at, number, body, merge_commit_sha } of data) {
    if (
      merged_at === null || user?.type === 'Bot' || merge_commit_sha === null
    ) {
      continue
    }

    if (
      status === 200 &&
      new Date(latestRelease.created_at).getTime() >
        new Date(merged_at).getTime()
    ) {
      continue
    }

    const c = await rest.repos.getCommit({
      ...context.repo,
      ref: merge_commit_sha,
    })

    if (c.status !== 200) {
      continue
    }

    const linkifyReferences = (commit: string) => {
      const issueRegex = /(?<!\w)(?:(?<organization>[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/(?<repository>[\w.-]{1,100}))?(?<!(?:\/\.{1,2}))#(?<issueNumber>[1-9]\d{0,9})\b/g
    
      const matches = commit.match(issueRegex)
    
      if (!matches)
        return commit
    
      for (const m of matches) {
        commit = commit.replace(`(${m})`, `([${m}](https://github.com/${context.repo.owner}/${context.repo.repo}/pull/${m.slice(1)}))`)
      }
    
      return commit
    }

    const i = c.data.commit.message.indexOf(')\n\n')
    const title = c.data.commit.message.substring(0, i > 0 ? i + 1 : undefined)

    const comments = (await rest.issues.listComments({
      ...context.repo,
      issue_number: number,
    })).data

    if (
      comments.length > 0 &&
      comments.some((c) =>
        c.body !== undefined && c.body === '?log ignore' &&
        (c.author_association === 'COLLABORATOR' ||
          c.author_association === 'MEMBER' || c.author_association === 'OWNER')
      )
    ) {
      continue
    }

    changelogBody += `\n* ${
      linkifyReferences(title)
    }`

    releaseBody += `\n* ${
      linkifyReferences(title)
    }`

    if (style.includes('author')) {
      changelogBody += user?.login
        ? ` by [@${user?.login}](https://github.com/${user?.login})`
        : ''

      releaseBody += user?.login ? ` by @${user?.login}` : ''
    }

    if (style.includes('description') && body !== null && body.length > 0) {
      changelogBody += `\n\n${indentString(body, 2)}\n`
      releaseBody += `\n\n${indentString(body, 2)}\n`
    }
  }

  const { data: release } = await rest.repos.createRelease({
    owner: context.repo.owner,
    repo: context.repo.repo,
    tag_name: tag,
    name: tag,
    body: releaseBody,
    draft: getBooleanInput('draft') ?? false,
    prerelease: tag.includes('canary') || tag.includes('nightly') ||
      tag.includes('rc') || getBooleanInput('prerelease'),
    target_commitish: context.sha,
  })

  const [sha, content] = await fetchChangelog()

  await rest.repos.createOrUpdateFileContents({
    ...context.repo,
    path: 'changelog.md',
    content: Buffer.from(
      `${changelogBody}${content === '' ? '\n' : `\n\n${content}`}`,
    ).toString('base64'),
    message: getInput('commit_message').replace('{tag}', tag),
    ...(sha !== null && { sha }),
  })

  setOutput('release_id', release.id)
  setOutput('tag_name', tag)
  setOutput('created_at', release.created_at)
  setOutput('release_body', releaseBody)
  setOutput('changelog_body', changelogBody)
}

try {
  action()
} catch (err) {
  setFailed(
    err instanceof Error ? err.message : 'Something unexpected happened.',
  )
}
